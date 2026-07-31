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
  parseAttempt,
  attemptLabel,
  planSavedSearch,
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

// pb_client_tag is the LIVE value the SDRs type into the import ("Club Hub", with
// the space) — not the PascalCase form, which only names the saved search.
const client = (over: Partial<any> = {}) =>
  ({ id: "client-1", external_id: "club-hub", name: "Club Hub", active: true, pb_client_tag: "Club Hub", pb_lead_score_prefix: "club", ...over } as any);

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

// Contact-POST + folder fetch mock (book snapshot goes through fetchMemberContacts).
// `folders` seeds the pre-existing folder list; a POST /folders appends and echoes back.
function contactFetch(onFail?: (phone: string) => any, opts: { folders?: Array<{ folder_id: string; folder_name: string }> } = {}) {
  const folders = [...(opts.folders ?? [])];
  let nextFolderId = 900;
  return vi.fn(async (url: string, init: any) => {
    if (url.includes("/folders") && (init?.method ?? "GET") === "GET") {
      return makeRes(200, { folders: { folders } });
    }
    if (url.includes("/folders") && init?.method === "POST") {
      const { name } = JSON.parse(init.body);
      const created = { folder_id: String(nextFolderId++), folder_name: name };
      folders.push(created);
      return makeRes(200, { folder: created });
    }
    if (url.includes("/contacts") && init?.method === "POST") {
      const body = JSON.parse(init.body);
      const bad = onFail?.(body.phone);
      return bad ?? makeRes(200, { contact_user_id: "c1" });
    }
    throw new Error(`unexpected fetch: ${init?.method} ${url}`);
  });
}

const folderCalls = (fetchMock: any, method: string) =>
  fetchMock.mock.calls.filter((c: any) => c[0].includes("/folders") && (c[1]?.method ?? "GET") === method);

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

describe("parseAttempt / attemptLabel", () => {
  it("reads words, digits and numbers; defaults to the first pass", () => {
    expect(parseAttempt("first attempt")).toBe(1);
    expect(parseAttempt("2nd")).toBe(2);
    expect(parseAttempt("third attempt")).toBe(3);
    expect(parseAttempt(4)).toBe(4);
    expect(parseAttempt(undefined)).toBe(1);
    expect(parseAttempt("nonsense")).toBe(1);
  });

  it("renders the org's ordinal labels", () => {
    expect(attemptLabel(1)).toBe("1st Attempt");
    expect(attemptLabel(2)).toBe("2nd Attempt");
    expect(attemptLabel(3)).toBe("3rd Attempt");
    expect(attemptLabel(4)).toBe("4th Attempt");
    expect(attemptLabel(11)).toBe("11th Attempt");
  });
});

describe("planSavedSearch", () => {
  it("standing folder drops the per-list Lead Score so it absorbs later uploads", () => {
    const plan = planSavedSearch({
      clientName: "Club Hub",
      clientTag: "Club Hub",
      campaign: "ISTE 2026 TAM",
      leadScore: "CLUB8",
      attemptOrdinal: 1,
    });

    expect(plan.api_available).toBe(false);
    expect(plan.standing).toEqual({
      name: "ClubHub: 1st Attempt",
      criteria: ["tag = Club Hub", "dial attempts = 0"],
      build_once: true,
    });
    // The per-list variant matches the folders already in the account, e.g.
    // "ClubHub: Public School Signal-Based Targeting - 1st Attempt".
    expect(plan.per_list).toEqual({
      name: "ClubHub: ISTE 2026 TAM - 1st Attempt",
      criteria: ["tag = Club Hub", "Lead Score = CLUB8", "dial attempts = 0"],
    });
  });

  it("maps the Nth attempt to N-1 dials", () => {
    const plan = planSavedSearch({
      clientName: "Club Hub", clientTag: "Club Hub", campaign: null, leadScore: null, attemptOrdinal: 3,
    });
    expect(plan.standing.name).toBe("ClubHub: 3rd Attempt");
    expect(plan.standing.criteria).toContain("dial attempts = 2");
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
  it("tags exactly what the manual import types, and stamps Lead Score + Job Title as array custom fields", async () => {
    const fetchMock = contactFetch();
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(
      client(),
      sdr(),
      [{ phone: "+12128675309", first_name: "Ada", last_name: "Lovelace", title: "CTO", company: "AE" }],
      { campaign: "ISTE 2026 TAM", attempt: "first attempt" }
    );

    expect(result.clientTag).toBe("Club Hub");
    // Loom 4:17: "fresh leads, club hub, then the name of the campaign".
    expect(result.tags).toEqual(["fresh leads", "Club Hub", "ISTE 2026 TAM"]);
    expect(result.leadScore).toEqual({ prefix: "club", seq: 9, value: "club9", issued: true });
    expect(issueMock).toHaveBeenCalledTimes(1);

    const body = bodiesOf(fetchMock)[0];
    expect(body).toMatchObject({ owner_id: "111", on_duplicate: "update" });
    expect(body.tags).toEqual(["fresh leads", "Club Hub", "ISTE 2026 TAM"]);
    expect(body.custom_fields).toEqual([
      { name: "Job Title", type: 1, value: "CTO" },
      { name: "Lead Score", type: 1, value: "club9" },
    ]);
  });

  it("creates the dial folder, files contacts into it, and reports nothing left to build", async () => {
    const fetchMock = contactFetch();
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(
      client(),
      sdr(),
      [{ phone: "+12128675309", first_name: "Ada" }, { phone: "+14084567890", first_name: "Bob" }],
      { campaign: "ISTE 2026 TAM" }
    );

    // Folder named by the org's own per-list convention.
    expect(result.folder).toMatchObject({
      name: "ClubHub: ISTE 2026 TAM - 1st Attempt",
      created: true,
      would_create: false,
      assigned: 2,
      left_in_place: 0,
    });
    expect(folderCalls(fetchMock, "POST")).toHaveLength(1);

    // Every contact carries the folder id as category_id.
    for (const body of bodiesOf(fetchMock)) expect(body.category_id).toBe(result.folder!.id);

    // The whole point: the SDR has nothing to build.
    expect(result.savedSearch.needed).toBe(false);
    expect(result.savedSearch.reason).toContain("Nothing to build");
  });

  it("reuses an existing folder instead of creating a duplicate (case-insensitive)", async () => {
    const fetchMock = contactFetch(undefined, {
      folders: [{ folder_id: "77", folder_name: "clubhub: iste 2026 tam - 1st attempt" }],
    });
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(client(), sdr(), [{ phone: "+12128675309" }], { campaign: "ISTE 2026 TAM" });

    expect(result.folder).toMatchObject({ id: "77", created: false, assigned: 1 });
    expect(folderCalls(fetchMock, "POST")).toHaveLength(0);
    expect(bodiesOf(fetchMock)[0].category_id).toBe("77");
  });

  it("leaves OVERLAPPING contacts in their current folder by default, and says so", async () => {
    // Bob is already in the book → overlap. A contact has one category_id, so moving
    // him could yank him out of a list the SDR is mid-way through.
    fetchBookMock.mockResolvedValue([
      { id: "x", emails: ["bob@x.com"], phones: [], category: null, do_not_call: false, raw: {} },
    ]);
    const fetchMock = contactFetch();
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(
      client(),
      sdr(),
      [
        { phone: "+12128675309", first_name: "Ada", email: "ada@x.com" }, // net-new
        { phone: "+14084567890", first_name: "Bob", email: "bob@x.com" }, // overlap
      ],
      { campaign: "ISTE 2026 TAM", dncScrub: false }
    );

    expect(result.folder).toMatchObject({ assigned: 1, left_in_place: 1 });
    const [ada, bob] = bodiesOf(fetchMock);
    expect(ada.category_id).toBe(result.folder!.id);
    expect(bob).not.toHaveProperty("category_id");

    // Partial folder → be honest that UI work may remain.
    expect(result.savedSearch.needed).toBe(true);
    expect(result.savedSearch.reason).toContain("stayed in their existing folder");
  });

  it("folder_assign:'all' moves overlaps into the folder too", async () => {
    fetchBookMock.mockResolvedValue([
      { id: "x", emails: ["bob@x.com"], phones: [], category: null, do_not_call: false, raw: {} },
    ]);
    const fetchMock = contactFetch();
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(
      client(),
      sdr(),
      [
        { phone: "+12128675309", first_name: "Ada", email: "ada@x.com" },
        { phone: "+14084567890", first_name: "Bob", email: "bob@x.com" },
      ],
      { campaign: "ISTE 2026 TAM", dncScrub: false, folderAssign: "all" }
    );

    expect(result.folder).toMatchObject({ assigned: 2, left_in_place: 0 });
    for (const body of bodiesOf(fetchMock)) expect(body.category_id).toBe(result.folder!.id);
    expect(result.savedSearch.needed).toBe(false);
  });

  it("folder_assign:'none' touches no folders and falls back to the saved-search recipe", async () => {
    const fetchMock = contactFetch();
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(client(), sdr(), [{ phone: "+12128675309" }], {
      campaign: "ISTE 2026 TAM",
      folderAssign: "none",
    });

    expect(result.folder).toBeNull();
    expect(fetchMock.mock.calls.filter((c: any) => c[0].includes("/folders"))).toHaveLength(0);
    expect(bodiesOf(fetchMock)[0]).not.toHaveProperty("category_id");
    expect(result.savedSearch.needed).toBe(true);
    expect(result.savedSearch.reason).toContain("No dial folder");
  });

  it("honors an explicit folder name override", async () => {
    const fetchMock = contactFetch();
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(client(), sdr(), [{ phone: "+12128675309" }], {
      campaign: "ISTE 2026 TAM",
      folder: "Club Hub — ISTE booth follow-up",
    });

    expect(result.folder!.name).toBe("Club Hub — ISTE booth follow-up");
    expect(JSON.parse(folderCalls(fetchMock, "POST")[0][1].body).name).toBe("Club Hub — ISTE booth follow-up");
  });

  it("surfaces a folder-creation failure as a 502 rather than uploading unfiled contacts", async () => {
    // 400, not 500 — withRetry backs 5xx off exponentially (correct in prod, slow in a test).
    (global as any).fetch = vi.fn(async (url: string, init: any) => {
      if (url.includes("/folders") && (init?.method ?? "GET") === "GET") return makeRes(200, { folders: { folders: [] } });
      if (url.includes("/folders")) return makeRes(400, "invalid folder name");
      throw new Error("must not POST contacts when the folder failed");
    });

    await expect(
      uploadContacts(client(), sdr(), [{ phone: "+12128675309" }], { campaign: "ISTE 2026 TAM" })
    ).rejects.toMatchObject({ status: 502, message: expect.stringContaining("invalid folder name") });
  });

  it("keeps '<Client>: <Campaign>' and the attempt OUT of tags (they name/filter the saved search)", async () => {
    (global as any).fetch = contactFetch();

    const result = await uploadContacts(
      client(),
      sdr(),
      [{ phone: "+12128675309", first_name: "Ada" }],
      { campaign: "ISTE 2026 TAM", attempt: "2nd attempt" }
    );

    expect(result.tags).not.toContain("Club Hub: ISTE 2026 TAM");
    expect(result.tags).not.toContain("2nd attempt");
    expect(result.savedSearch.standing.name).toBe("ClubHub: 2nd Attempt");
    expect(result.savedSearch.standing.criteria).toContain("dial attempts = 1");
    expect(result.savedSearch.per_list.name).toBe("ClubHub: ISTE 2026 TAM - 2nd Attempt");
  });

  it("fresh_leads_tag:false drops the fresh-leads tag (re-tagging leads already in the book)", async () => {
    (global as any).fetch = contactFetch();

    const result = await uploadContacts(
      client(),
      sdr(),
      [{ phone: "+12128675309", first_name: "Ada" }],
      { campaign: "ISTE 2026 TAM", freshLeadsTag: false }
    );

    expect(result.tags).toEqual(["Club Hub", "ISTE 2026 TAM"]);
  });

  it("falls back to the PascalCase tag when pb_client_tag is unset", async () => {
    (global as any).fetch = contactFetch();

    const result = await uploadContacts(
      client({ pb_client_tag: null }),
      sdr(),
      [{ phone: "+12128675309", first_name: "Ada" }],
      {}
    );

    expect(result.clientTag).toBe("ClubHub");
    expect(result.tags).toEqual(["fresh leads", "ClubHub"]);
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

  it("dry_run peeks the Lead Score and writes NOTHING (folder lookup is read-only)", async () => {
    const fetchMock = contactFetch();
    (global as any).fetch = fetchMock;

    const result = await uploadContacts(client(), sdr(), [{ phone: "+12128675309" }], {
      campaign: "ISTE 2026 TAM",
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.leadScore).toEqual({ prefix: "club", seq: 9, value: "club9", issued: false });
    expect(peekMock).toHaveBeenCalledTimes(1);
    expect(issueMock).not.toHaveBeenCalled();

    // A dry run may READ (to report whether the folder exists) but must never write.
    const posts = fetchMock.mock.calls.filter((c: any) => c[1]?.method === "POST");
    expect(posts).toHaveLength(0);
    expect(folderCalls(fetchMock, "GET")).toHaveLength(1);

    // ...and it reports what WOULD happen.
    expect(result.folder).toMatchObject({
      id: null,
      name: "ClubHub: ISTE 2026 TAM - 1st Attempt",
      created: false,
      would_create: true,
      assigned: 1,
      left_in_place: 0,
    });
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
