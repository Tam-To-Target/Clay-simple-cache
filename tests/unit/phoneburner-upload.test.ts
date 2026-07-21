import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/prisma", () => ({
  default: {
    phoneburnerMember: { findMany: vi.fn() },
    dncEntry: { count: vi.fn() },
  },
}));

vi.mock("../../src/services/phoneburner-token.service", async (importActual) => {
  const actual = (await importActual()) as any;
  return { ...actual, getMemberToken: vi.fn() };
});

vi.mock("../../src/services/dnc.service", async (importActual) => {
  const actual = (await importActual()) as any;
  return { ...actual, dncService: { findMatch: vi.fn() } };
});

vi.mock("../../src/config/registry", async (importActual) => {
  const actual = (await importActual()) as any;
  return { ...actual, loadRegistry: vi.fn() };
});

vi.mock("../../src/services/phoneburner.service", async (importActual) => {
  const actual = (await importActual()) as any;
  return { ...actual, fetchMemberContacts: vi.fn() };
});

vi.mock("../../src/services/pb-lead-score.service", () => ({
  issueLeadScore: vi.fn(),
  peekNextLeadScore: vi.fn(),
  recordLeadScore: vi.fn(),
}));

import prisma from "../../src/db/prisma";
import { getMemberToken } from "../../src/services/phoneburner-token.service";
import { dncService } from "../../src/services/dnc.service";
import { loadRegistry } from "../../src/config/registry";
import { fetchMemberContacts } from "../../src/services/phoneburner.service";
import { issueLeadScore, peekNextLeadScore, recordLeadScore } from "../../src/services/pb-lead-score.service";
import {
  resolveClientSdrs,
  selectSdr,
  deriveClientTag,
  uploadContacts,
  UploadInputError,
  type SdrOption,
} from "../../src/services/phoneburner-upload.service";

const mockPrisma = prisma as any;
const tokenMock = getMemberToken as any;
const findMatchMock = dncService.findMatch as any;
const loadRegistryMock = loadRegistry as any;
const fetchBookMock = fetchMemberContacts as any;
const issueMock = issueLeadScore as any;
const peekMock = peekNextLeadScore as any;
const recordMock = recordLeadScore as any;

const client = (over: Partial<any> = {}) =>
  ({ id: "client-1", external_id: "club-hub", name: "Club Hub", active: true, pb_client_tag: "ClubHub", pb_lead_score_prefix: "club", ...over } as any);

const sdr = (over: Partial<SdrOption> = {}): SdrOption => ({
  pbMemberId: "111",
  name: "Prince Derek",
  username: "prince@tamtotarget.com",
  slug: "prince-derek",
  ...over,
});

function makeRes(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as any;
}

// Contact-POST fetch mock (book snapshot goes through fetchMemberContacts, not fetch).
function contactFetch(onFail?: (phone: string) => any) {
  return vi.fn(async (url: string, init: any) => {
    if (url.includes("/contacts") && init?.method === "POST") {
      const body = JSON.parse(init.body);
      const bad = onFail?.(body.phone);
      return bad ?? makeRes(200, { contact_user_id: "c1" });
    }
    throw new Error(`unexpected fetch: ${init?.method} ${url}`);
  });
}

const bodiesOf = (fetchMock: any) =>
  fetchMock.mock.calls.filter((c: any) => c[0].includes("/contacts") && c[1]?.method === "POST").map((c: any) => JSON.parse(c[1].body));

beforeEach(() => {
  vi.clearAllMocks();
  tokenMock.mockResolvedValue("tok-abc");
  findMatchMock.mockResolvedValue(null);
  loadRegistryMock.mockReturnValue({ clients: [] });
  mockPrisma.dncEntry.count.mockResolvedValue(5); // client has DNC coverage by default
  fetchBookMock.mockResolvedValue([]); // empty book → everyone net-new
  issueMock.mockResolvedValue({ prefix: "club", seq: 9, value: "club9" });
  peekMock.mockResolvedValue({ prefix: "club", seq: 9, value: "club9" });
  recordMock.mockResolvedValue(undefined);
});

describe("deriveClientTag", () => {
  it("PascalCases the client name", () => {
    expect(deriveClientTag("Club Hub")).toBe("ClubHub");
    expect(deriveClientTag("Scarlet by RedDrop")).toBe("ScarletByRedDrop");
  });
});

describe("resolveClientSdrs / selectSdr", () => {
  it("resolves active members and disambiguates slug collisions", async () => {
    mockPrisma.phoneburnerMember.findMany.mockResolvedValue([
      { pb_member_id: "1111", pb_username: null },
      { pb_member_id: "2222", pb_username: null },
    ]);
    loadRegistryMock.mockReturnValue({
      clients: [{ phoneburner_members: [
        { pb_member_id: "1111", name: "Sara Johnson", username: null },
        { pb_member_id: "2222", name: "Sara Johnson", username: null },
      ] }],
    });
    const sdrs = await resolveClientSdrs(client());
    expect(sdrs.map((s) => s.slug)).toEqual(["sara-johnson", "sara-johnson-2222"]);
  });

  it("409s when >1 SDR and no query; matches by slug/name/email/id otherwise", () => {
    const list = [sdr(), sdr({ pbMemberId: "222", slug: "sara-johnson", name: "Sara Johnson", username: "sara@x.com" })];
    expect(() => selectSdr(list)).toThrow(UploadInputError);
    expect(selectSdr(list, "sara@x.com").pbMemberId).toBe("222");
    expect(selectSdr(list, "222").pbMemberId).toBe("222");
    expect(selectSdr([sdr()]).pbMemberId).toBe("111");
  });
});

describe("uploadContacts", () => {
  it("builds client+campaign tags and stamps Lead Score + Job Title as array custom fields", async () => {
    const fetchMock = contactFetch();
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(
      client(),
      sdr(),
      [{ phone: "+12128675309", first_name: "Ada", last_name: "Lovelace", title: "CTO", company: "AE" }],
      { campaign: "ISTE 2026 TAM", attempt: "first attempt" }
    );

    expect(result.clientTag).toBe("ClubHub");
    expect(result.tags).toEqual(["ClubHub", "ClubHub: ISTE 2026 TAM", "first attempt"]);
    expect(result.leadScore).toEqual({ prefix: "club", seq: 9, value: "club9", issued: true });
    expect(issueMock).toHaveBeenCalledTimes(1);

    const body = bodiesOf(fetchMock)[0];
    expect(body).toMatchObject({ owner_id: "111", on_duplicate: "update" });
    expect(body).not.toHaveProperty("category_id"); // folders are gone
    expect(body.custom_fields).toEqual([
      { name: "Job Title", type: 1, value: "CTO" },
      { name: "Lead Score", type: 1, value: "club9" },
    ]);
  });

  it("stamps Lead Score on net-new only; existing (overlap) contacts keep theirs", async () => {
    // Book already contains bob@x.com → Bob is an overlap.
    fetchBookMock.mockResolvedValue([{ id: "x", emails: ["bob@x.com"], phones: [], category: null, do_not_call: false, raw: {} }]);
    const fetchMock = contactFetch();
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(
      client(),
      sdr(),
      [
        { phone: "+12128675309", first_name: "Ada", email: "ada@x.com" }, // net-new
        { phone: "+14084567890", first_name: "Bob", email: "bob@x.com" }, // overlap
      ],
      { campaign: "C", dncScrub: false }
    );

    expect(result.totals).toMatchObject({ net_new: 1, overlap: 1, uploaded: 2 });
    const bodies = bodiesOf(fetchMock);
    const ada = bodies.find((b: any) => b.first_name === "Ada");
    const bob = bodies.find((b: any) => b.first_name === "Bob");
    expect(ada.custom_fields).toEqual([{ name: "Lead Score", type: 1, value: "club9" }]);
    expect(bob.custom_fields ?? []).not.toContainEqual({ name: "Lead Score", type: 1, value: "club9" });
  });

  it("reports DNC coverage and every collision", async () => {
    findMatchMock.mockImplementation(async (_c: string, ids: any) =>
      ids.phone_e164 === "+13102345678" ? { matchedOn: "phone", matchedValue: "+13102345678", entry: {} } : null
    );
    (global as any).fetch = contactFetch();

    const result = await uploadContacts(
      client(),
      sdr(),
      [{ phone: "+12128675309" }, { phone: "+13102345678" }],
      {}
    );
    expect(result.dnc).toEqual({ scrubbed: true, entries_present: true, skipped: 1 });
    expect(result.totals).toMatchObject({ dnc_skipped: 1, attempted: 1, uploaded: 1 });
    expect(result.dnc_skipped[0]).toMatchObject({ phone: "+13102345678", matched_on: "phone" });
  });

  it("flags absent DNC coverage (entries_present=false) instead of silently passing", async () => {
    mockPrisma.dncEntry.count.mockResolvedValue(0);
    (global as any).fetch = contactFetch();
    const result = await uploadContacts(client(), sdr(), [{ phone: "+12128675309" }], {});
    expect(result.dnc).toEqual({ scrubbed: true, entries_present: false, skipped: 0 });
  });

  it("when the book can't be read, net_new/overlap are null and Lead Score falls back to all", async () => {
    const { PhoneburnerAccessError } = await import("../../src/services/phoneburner.service");
    fetchBookMock.mockRejectedValue(new PhoneburnerAccessError("111", "no access"));
    const fetchMock = contactFetch();
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(client(), sdr(), [{ phone: "+12128675309", first_name: "Ada" }], { dncScrub: false });
    expect(result.totals.net_new).toBeNull();
    expect(result.totals.overlap).toBeNull();
    expect(bodiesOf(fetchMock)[0].custom_fields).toContainEqual({ name: "Lead Score", type: 1, value: "club9" });
  });

  it("dry_run peeks the Lead Score, creates nothing, records nothing", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("dry_run must not POST contacts"); });
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(client(), sdr(), [{ phone: "+12128675309" }], { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.leadScore).toEqual({ prefix: "club", seq: 9, value: "club9", issued: false });
    expect(peekMock).toHaveBeenCalledTimes(1);
    expect(issueMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled(); // no /contacts POST
  });

  it("records (does not mint) an explicit lead_score override", async () => {
    (global as any).fetch = contactFetch();
    const result = await uploadContacts(client(), sdr(), [{ phone: "+12128675309" }], { leadScore: "club42" });
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(issueMock).not.toHaveBeenCalled();
    expect(result.leadScore).toEqual({ value: "club42", prefix: "club", seq: 42, issued: false });
  });

  it("reports invalid phones and per-contact failures without aborting", async () => {
    const fetchMock = contactFetch((phone) => (phone === "+14084567890" ? makeRes(422, { message: "bad" }) : undefined));
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(
      client(),
      sdr(),
      [{ phone: "+12128675309" }, { phone: "+14084567890" }, { phone: "abc" }],
      { dncScrub: false }
    );
    expect(result.totals).toMatchObject({ received: 3, invalid: 1, attempted: 2, uploaded: 1, failed: 1 });
    expect(result.failed[0]).toMatchObject({ phone: "+14084567890", status: 422 });
  });

  it("throws 400 when GTMOS has no token for the SDR (non-dry-run)", async () => {
    tokenMock.mockResolvedValue(null);
    await expect(uploadContacts(client(), sdr(), [{ phone: "+12128675309" }], {})).rejects.toBeInstanceOf(UploadInputError);
  });
});
