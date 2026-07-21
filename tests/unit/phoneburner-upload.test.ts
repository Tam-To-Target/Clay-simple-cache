import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/prisma", () => ({
  default: {
    phoneburnerMember: { findMany: vi.fn() },
  },
}));

vi.mock("../../src/services/phoneburner-token.service", async (importActual) => {
  const actual = (await importActual()) as any;
  return {
    ...actual,
    getMemberToken: vi.fn(),
  };
});

vi.mock("../../src/services/dnc.service", async (importActual) => {
  const actual = (await importActual()) as any;
  return {
    ...actual,
    dncService: { findMatch: vi.fn() },
  };
});

vi.mock("../../src/config/registry", async (importActual) => {
  const actual = (await importActual()) as any;
  return {
    ...actual,
    loadRegistry: vi.fn(),
  };
});

import prisma from "../../src/db/prisma";
import { getMemberToken } from "../../src/services/phoneburner-token.service";
import { dncService } from "../../src/services/dnc.service";
import { loadRegistry } from "../../src/config/registry";
import {
  resolveClientSdrs,
  selectSdr,
  uploadContacts,
  UploadInputError,
  type SdrOption,
} from "../../src/services/phoneburner-upload.service";

const mockPrisma = prisma as any;
const tokenMock = getMemberToken as any;
const findMatchMock = dncService.findMatch as any;
const loadRegistryMock = loadRegistry as any;

const client = (over: Partial<any> = {}) =>
  ({ id: "client-1", external_id: "club-hub", name: "Club Hub", active: true, ...over } as any);

const sdr = (over: Partial<SdrOption> = {}): SdrOption => ({
  pbMemberId: "111",
  name: "Prince Derek",
  username: "prince@tamtotarget.com",
  slug: "prince-derek",
  ...over,
});

// Minimal fetch Response stand-in (withRetry only reads status/headers.get).
function makeRes(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  tokenMock.mockResolvedValue("tok-abc");
  findMatchMock.mockResolvedValue(null); // nobody on DNC by default
  loadRegistryMock.mockReturnValue({ clients: [] });
});

describe("resolveClientSdrs", () => {
  it("enriches names from the registry and builds stable slugs", async () => {
    mockPrisma.phoneburnerMember.findMany.mockResolvedValue([
      { pb_member_id: "111", pb_username: "prince@tamtotarget.com" },
      { pb_member_id: "222", pb_username: "sara@tamtotarget.com" },
    ]);
    loadRegistryMock.mockReturnValue({
      clients: [
        {
          phoneburner_members: [
            { pb_member_id: "111", name: "Prince Derek", username: "prince@tamtotarget.com" },
            { pb_member_id: "222", name: "Sara Johnson", username: "sara@tamtotarget.com" },
          ],
        },
      ],
    });

    const sdrs = await resolveClientSdrs(client());
    expect(sdrs).toHaveLength(2);
    expect(sdrs[0]).toMatchObject({ pbMemberId: "111", name: "Prince Derek", slug: "prince-derek" });
    expect(sdrs[1]).toMatchObject({ pbMemberId: "222", name: "Sara Johnson", slug: "sara-johnson" });
  });

  it("falls back to the email local-part when the registry has no name", async () => {
    mockPrisma.phoneburnerMember.findMany.mockResolvedValue([
      { pb_member_id: "333", pb_username: "casey@tamtotarget.com" },
    ]);
    loadRegistryMock.mockReturnValue({ clients: [] });
    const sdrs = await resolveClientSdrs(client());
    expect(sdrs[0]).toMatchObject({ name: "casey", slug: "casey" });
  });

  it("disambiguates colliding slugs by member id", async () => {
    mockPrisma.phoneburnerMember.findMany.mockResolvedValue([
      { pb_member_id: "1111", pb_username: null },
      { pb_member_id: "2222", pb_username: null },
    ]);
    loadRegistryMock.mockReturnValue({
      clients: [
        {
          phoneburner_members: [
            { pb_member_id: "1111", name: "Sara Johnson", username: null },
            { pb_member_id: "2222", name: "Sara Johnson", username: null },
          ],
        },
      ],
    });
    const sdrs = await resolveClientSdrs(client());
    expect(sdrs[0].slug).toBe("sara-johnson");
    expect(sdrs[1].slug).toBe("sara-johnson-2222");
  });
});

describe("selectSdr", () => {
  it("returns the sole SDR when no query is given", () => {
    const s = sdr();
    expect(selectSdr([s])).toBe(s);
  });

  it("throws 409 with the option list when >1 SDR and no query", () => {
    const list = [sdr(), sdr({ pbMemberId: "222", slug: "sara-johnson", name: "Sara Johnson" })];
    try {
      selectSdr(list);
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(UploadInputError);
      expect(e.status).toBe(409);
      expect(e.payload.needs_sdr).toBe(true);
      expect(e.payload.sdrs).toHaveLength(2);
    }
  });

  it("matches by slug, name, email, and member id", () => {
    const list = [sdr(), sdr({ pbMemberId: "222", slug: "sara-johnson", name: "Sara Johnson", username: "sara@x.com" })];
    expect(selectSdr(list, "sara-johnson").pbMemberId).toBe("222");
    expect(selectSdr(list, "Sara Johnson").pbMemberId).toBe("222");
    expect(selectSdr(list, "sara@x.com").pbMemberId).toBe("222");
    expect(selectSdr(list, "222").pbMemberId).toBe("222");
    expect(selectSdr(list, "Prince Derek").pbMemberId).toBe("111");
  });

  it("throws 400 when the query matches no assigned SDR", () => {
    try {
      selectSdr([sdr()], "nobody");
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(UploadInputError);
      expect(e.status).toBe(400);
      expect(e.payload.needs_sdr).toBe(true);
    }
  });

  it("throws 400 when the client has no active SDRs", () => {
    try {
      selectSdr([]);
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.status).toBe(400);
    }
  });
});

describe("uploadContacts", () => {
  it("scrubs DNC hits, resolves an existing folder, tags, and uploads survivors", async () => {
    // Number #2 is on DNC.
    findMatchMock.mockImplementation(async (_c: string, ids: any) =>
      ids.phone_e164 === "+13102345678"
        ? { matchedOn: "phone", matchedValue: "+13102345678", entry: {} }
        : null
    );

    const fetchMock = vi.fn(async (url: string, init: any) => {
      if (url.includes("/folders") && (!init || init.method === "GET")) {
        return makeRes(200, { folders: [{ folder_id: "11888", folder_name: "club8" }] });
      }
      if (url.includes("/contacts") && init?.method === "POST") {
        return makeRes(200, { contact_user_id: "c-new" });
      }
      throw new Error(`unexpected fetch: ${init?.method} ${url}`);
    });
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(
      client(),
      sdr(),
      [
        { phone: "+12128675309", first_name: "Ada", last_name: "Lovelace", company: "Analytical Engine", email: "ada@x.com" },
        { phone: "+13102345678", name: "Blocked Person" }, // on DNC → skipped
        "+14084567890", // bare string
      ],
      { campaign: "ISTE 2026 TAM", leadGroup: "club8", attempt: "first attempt" }
    );

    expect(result.totals).toMatchObject({
      received: 3,
      invalid: 0,
      dnc_skipped: 1,
      attempted: 2,
      uploaded: 2,
      failed: 0,
    });
    expect(result.folder).toEqual({ id: "11888", name: "club8", created: false });
    expect(result.tags).toEqual(["Club Hub", "ISTE 2026 TAM", "first attempt"]);
    expect(result.dnc_skipped[0]).toMatchObject({ phone: "+13102345678", matched_on: "phone" });

    // No folder POST (it already existed); exactly 2 contact POSTs.
    const posts = fetchMock.mock.calls.filter((c: any) => c[1]?.method === "POST");
    const folderPosts = posts.filter((c: any) => c[0].includes("/folders"));
    const contactPosts = posts.filter((c: any) => c[0].includes("/contacts"));
    expect(folderPosts).toHaveLength(0);
    expect(contactPosts).toHaveLength(2);

    // owner_id + tags + category_id land on the create body.
    const body = JSON.parse(contactPosts[0][1].body);
    expect(body).toMatchObject({ owner_id: "111", category_id: "11888", on_duplicate: "update" });
    expect(body.tags).toEqual(["Club Hub", "ISTE 2026 TAM", "first attempt"]);
  });

  it("creates the folder when it does not already exist", async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => {
      if (url.includes("/folders") && (!init || init.method === "GET")) return makeRes(200, { folders: [] });
      if (url.includes("/folders") && init?.method === "POST")
        return makeRes(200, { folder: { folder_id: "999", folder_name: "club9" } });
      if (url.includes("/contacts") && init?.method === "POST") return makeRes(200, { contact_user_id: "c1" });
      throw new Error(`unexpected fetch: ${init?.method} ${url}`);
    });
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(client(), sdr(), [{ phone: "+12128675309" }], { leadGroup: "club9" });
    expect(result.folder).toEqual({ id: "999", name: "club9", created: true });
    expect(result.totals.uploaded).toBe(1);
  });

  it("reports invalid phones and never sends them", async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => {
      if (url.includes("/contacts") && init?.method === "POST") return makeRes(200, { contact_user_id: "c1" });
      throw new Error(`unexpected fetch: ${init?.method} ${url}`);
    });
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(
      client(),
      sdr(),
      [{ phone: "+12128675309" }, { first_name: "No", last_name: "Phone" }, { phone: "abc" }],
      {}
    );
    expect(result.totals).toMatchObject({ received: 3, invalid: 2, uploaded: 1 });
    expect(result.invalid).toHaveLength(2);
    const contactPosts = fetchMock.mock.calls.filter((c: any) => c[0].includes("/contacts"));
    expect(contactPosts).toHaveLength(1);
  });

  it("dry_run resolves nothing remotely and creates no contacts", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("dry_run must not call PhoneBurner");
    });
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(
      client(),
      sdr(),
      [{ phone: "+12128675309" }, { phone: "+14084567890" }],
      { leadGroup: "club8", dryRun: true }
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.totals).toMatchObject({ attempted: 2, uploaded: 0 });
    expect(result.folder).toEqual({ id: "", name: "club8", created: false });
  });

  it("records a per-contact PhoneBurner failure without aborting the batch", async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (url.includes("/contacts") && init?.method === "POST") {
        return body.phone === "+14084567890"
          ? makeRes(422, { message: "bad number" })
          : makeRes(200, { contact_user_id: "c1" });
      }
      throw new Error(`unexpected fetch: ${init?.method} ${url}`);
    });
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(
      client(),
      sdr(),
      [{ phone: "+12128675309" }, { phone: "+14084567890" }],
      { dncScrub: false }
    );
    expect(result.totals).toMatchObject({ attempted: 2, uploaded: 1, failed: 1 });
    expect(result.failed[0]).toMatchObject({ phone: "+14084567890", status: 422 });
  });

  it("skips the DNC check entirely when dnc_scrub is false", async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => {
      if (url.includes("/contacts") && init?.method === "POST") return makeRes(200, { contact_user_id: "c1" });
      throw new Error(`unexpected fetch: ${init?.method} ${url}`);
    });
    (global as any).fetch = fetchMock;

    await uploadContacts(client(), sdr(), [{ phone: "+12128675309" }], { dncScrub: false });
    expect(findMatchMock).not.toHaveBeenCalled();
  });

  it("throws 400 when GTMOS has no dialing token for the SDR (non-dry-run)", async () => {
    tokenMock.mockResolvedValue(null);
    await expect(
      uploadContacts(client(), sdr(), [{ phone: "+12128675309" }], {})
    ).rejects.toBeInstanceOf(UploadInputError);
  });
});
