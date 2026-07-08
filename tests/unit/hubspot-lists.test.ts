import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchListContacts,
  fetchListSize,
  searchDncLists,
  searchLists,
  HubspotListContact,
} from "../../src/services/hubspot-lists.service";

const getToken = async () => "portal-token";

function jsonRes(status: number, body: any): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("fetchListContacts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests memberships with limit=250 (raised page size)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(200, { results: [] })) // memberships page
      ;
    vi.stubGlobal("fetch", fetchMock);

    await fetchListContacts(getToken, "list1");

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/crm/v3/lists/list1/memberships");
    expect(url).toContain("limit=250");
  });

  it("dedupes membership ids before batch-reading", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(200, { results: [{ recordId: "1" }, { recordId: "1" }, { recordId: "2" }] }))
      .mockResolvedValueOnce(
        jsonRes(200, {
          results: [
            { id: "1", properties: { email: "a@corp.com", phone: null, hs_email_domain: "corp.com" } },
            { id: "2", properties: { email: "b@corp.com", phone: null, hs_email_domain: "corp.com" } },
          ],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const contacts = await fetchListContacts(getToken, "list1");
    expect(contacts).toHaveLength(2);

    // Batch-read body should only contain the 2 unique ids, not 3.
    const batchReadCall = fetchMock.mock.calls[1];
    const body = JSON.parse((batchReadCall[1] as RequestInit).body as string);
    expect(body.inputs).toHaveLength(2);
  });

  it("reuses known contacts and only batch-reads unknown ids", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes(200, { results: [{ recordId: "1" }, { recordId: "2" }, { recordId: "3" }] })
      )
      .mockResolvedValueOnce(
        jsonRes(200, {
          results: [{ id: "3", properties: { email: "new@corp.com", phone: null, hs_email_domain: "corp.com" } }],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const known = new Map<string, HubspotListContact>([
      ["1", { hubspot_id: "1", email: "one@corp.com", phone: null, email_domain: "corp.com" }],
      ["2", { hubspot_id: "2", email: "two@corp.com", phone: null, email_domain: "corp.com" }],
    ]);

    const contacts = await fetchListContacts(getToken, "list1", { known });

    expect(contacts.map((c) => c.hubspot_id).sort()).toEqual(["1", "2", "3"]);
    expect(contacts.find((c) => c.hubspot_id === "1")?.email).toBe("one@corp.com");
    expect(contacts.find((c) => c.hubspot_id === "3")?.email).toBe("new@corp.com");

    // Only 2 fetch calls total: 1 memberships page + 1 batch-read for the single unknown id.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const batchReadCall = fetchMock.mock.calls[1];
    const body = JSON.parse((batchReadCall[1] as RequestInit).body as string);
    expect(body.inputs).toEqual([{ id: "3" }]);
  });

  it("skips the batch-read call entirely when every id is known", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(200, { results: [{ recordId: "1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const known = new Map<string, HubspotListContact>([
      ["1", { hubspot_id: "1", email: "one@corp.com", phone: null, email_domain: "corp.com" }],
    ]);

    const contacts = await fetchListContacts(getToken, "list1", { known });
    expect(contacts).toEqual([known.get("1")]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // memberships only, no batch/read
  });

  it("returns an empty array when the list has no members", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(200, { results: [] })));
    const contacts = await fetchListContacts(getToken, "empty-list");
    expect(contacts).toEqual([]);
  });

  it("uses a throttle override when provided", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(200, { results: [] })));
    const throttle = vi.fn().mockResolvedValue(undefined);
    await fetchListContacts(getToken, "list1", { throttle });
    expect(throttle).toHaveBeenCalledTimes(1);
  });
});

describe("fetchListSize", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses hs_list_size from additionalProperties", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonRes(200, { list: { additionalProperties: { hs_list_size: "42" } } }))
    );
    const size = await fetchListSize(getToken, "list1");
    expect(size).toBe(42);
  });

  it("returns null on 404 (never throws)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(404, "")));
    const size = await fetchListSize(getToken, "missing-list");
    expect(size).toBeNull();
  });

  it("returns null when hs_list_size is absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(200, { list: { additionalProperties: {} } })));
    const size = await fetchListSize(getToken, "list1");
    expect(size).toBeNull();
  });

  it("returns null (never throws) on a 5xx failure", async () => {
    // withRetry retries 5xx with real backoff delays — use fake timers so the
    // retry loop (MAX_RETRIES inside hsFetch) drains instantly. Pass an
    // explicit no-op throttle override so this doesn't ride the module-level
    // shared throttle (whose promise chain is real-timer-based from other
    // tests in this file and would deadlock a fake-timer run).
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(500, "boom")));
      const p = fetchListSize(getToken, "list1", { throttle: () => Promise.resolve() });
      await vi.runAllTimersAsync();
      const size = await p;
      expect(size).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null instead of throwing if fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const size = await fetchListSize(getToken, "list1", { throttle: () => Promise.resolve() });
    expect(size).toBeNull();
  });

  it("requests only the hs_list_size additional property", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonRes(200, { list: { additionalProperties: { hs_list_size: "5" } } }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchListSize(getToken, "list1");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("additionalPropertyNames=hs_list_size");
  });
});

describe("searchDncLists", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns contact_count parsed from hs_list_size alongside level classification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonRes(200, {
          lists: [
            {
              list: {
                listId: "1",
                name: "TAM - Do Not Contact (Individual)",
                additionalProperties: { hs_list_size: "10" },
              },
            },
            {
              list: {
                listId: "2",
                name: "TAM - Do Not Contact (Domain)",
                additionalProperties: {},
              },
            },
          ],
        })
      )
    );
    const lists = await searchDncLists(getToken, "TAM - Do Not Contact");
    expect(lists).toEqual([
      { listId: "1", name: "TAM - Do Not Contact (Individual)", level: "individual", contact_count: 10 },
      { listId: "2", name: "TAM - Do Not Contact (Domain)", level: "domain", contact_count: null },
    ]);
  });
});

describe("searchLists throttle passthrough", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the throttle override when provided", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(200, { lists: [] })));
    const throttle = vi.fn().mockResolvedValue(undefined);
    await searchLists(getToken, "", 100, { throttle });
    expect(throttle).toHaveBeenCalledTimes(1);
  });
});
