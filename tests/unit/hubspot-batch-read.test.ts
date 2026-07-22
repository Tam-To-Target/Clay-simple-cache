import { describe, it, expect, vi, afterEach } from "vitest";
import { batchReadContactProperties } from "../../src/services/hubspot-lists.service";

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

describe("batchReadContactProperties", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an empty map and makes no fetch call when ids is empty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await batchReadContactProperties(getToken, [], ["email"]);

    expect(result).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps id -> properties correctly for a single batch", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonRes(200, {
        results: [
          { id: "1", properties: { email: "a@corp.com", meeting_scheduled_date: "1700000000000" } },
          { id: "2", properties: { email: "b@corp.com", meeting_scheduled_date: null } },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await batchReadContactProperties(getToken, ["1", "2"], [
      "email",
      "meeting_scheduled_date",
    ]);

    expect(result.get("1")).toEqual({ email: "a@corp.com", meeting_scheduled_date: "1700000000000" });
    expect(result.get("2")).toEqual({ email: "b@corp.com", meeting_scheduled_date: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.properties).toEqual(["email", "meeting_scheduled_date"]);
    expect(body.inputs).toEqual([{ id: "1" }, { id: "2" }]);
  });

  it("defaults to an empty object when a result has no properties", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonRes(200, { results: [{ id: "1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await batchReadContactProperties(getToken, ["1"], ["email"]);
    expect(result.get("1")).toEqual({});
  });

  it("chunks more than 100 ids into multiple batch calls", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(i + 1));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes(200, {
          results: ids.slice(0, 100).map((id) => ({ id, properties: { email: `${id}@corp.com` } })),
        })
      )
      .mockResolvedValueOnce(
        jsonRes(200, {
          results: ids.slice(100, 200).map((id) => ({ id, properties: { email: `${id}@corp.com` } })),
        })
      )
      .mockResolvedValueOnce(
        jsonRes(200, {
          results: ids.slice(200, 250).map((id) => ({ id, properties: { email: `${id}@corp.com` } })),
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await batchReadContactProperties(getToken, ids, ["email"]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.size).toBe(250);
    expect(result.get("1")).toEqual({ email: "1@corp.com" });
    expect(result.get("250")).toEqual({ email: "250@corp.com" });

    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(firstBody.inputs).toHaveLength(100);
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(secondBody.inputs).toHaveLength(100);
    const thirdBody = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
    expect(thirdBody.inputs).toHaveLength(50);
  });

  it("throws with the HTTP status and body on a non-OK response", async () => {
    // withRetry retries 5xx with real backoff delays — use fake timers so the
    // retry loop drains instantly, and an explicit no-op throttle override so
    // this doesn't ride the module-level shared throttle (real-timer-based
    // from other tests in the file, which would deadlock a fake-timer run).
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(500, "boom")));
      const p = batchReadContactProperties(getToken, ["1"], ["email"], { throttle: () => Promise.resolve() });
      const assertion = expect(p).rejects.toThrow(/HubSpot batch read failed: HTTP 500 boom/);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
