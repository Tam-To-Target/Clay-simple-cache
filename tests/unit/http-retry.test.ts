import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, createThrottle, createKeyedThrottle, mapWithConcurrency, sleep } from "../../src/services/http-retry";

const res = (status: number, headers: Record<string, string> = {}) =>
  ({ status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } } as unknown as Response);

const noThrottle = () => Promise.resolve();

describe("withRetry", () => {
  it("returns the response and resolves the token once on success", async () => {
    const getToken = vi.fn().mockResolvedValue("t1");
    const requestFn = vi.fn().mockResolvedValue(res(200));
    const out = await withRetry(requestFn, getToken, { throttle: noThrottle, maxRetries: 3 });
    expect(out.status).toBe(200);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledWith(false);
  });

  it("force-refreshes the token on 401 and retries", async () => {
    const getToken = vi.fn().mockResolvedValueOnce("stale").mockResolvedValueOnce("fresh");
    const requestFn = vi
      .fn()
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(200));
    const out = await withRetry(requestFn, getToken, { throttle: noThrottle, maxRetries: 3 });
    expect(out.status).toBe(200);
    expect(getToken).toHaveBeenNthCalledWith(1, false);
    expect(getToken).toHaveBeenNthCalledWith(2, true); // forced refresh
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("stops refreshing after maxTokenRefreshes and returns the 401", async () => {
    const getToken = vi.fn().mockResolvedValue("t");
    const requestFn = vi.fn().mockResolvedValue(res(401));
    const out = await withRetry(requestFn, getToken, {
      throttle: noThrottle,
      maxRetries: 5,
      maxTokenRefreshes: 1,
    });
    expect(out.status).toBe(401);
    // initial + 1 allowed refresh = 2 requests
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a normal 4xx (e.g. 404)", async () => {
    const getToken = vi.fn().mockResolvedValue("t");
    const requestFn = vi.fn().mockResolvedValue(res(404));
    const out = await withRetry(requestFn, getToken, { throttle: noThrottle, maxRetries: 3 });
    expect(out.status).toBe(404);
    expect(requestFn).toHaveBeenCalledTimes(1);
  });

  describe("with fake timers (backoff)", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("retries on 429 then succeeds", async () => {
      const getToken = vi.fn().mockResolvedValue("t");
      const requestFn = vi
        .fn()
        .mockResolvedValueOnce(res(429))
        .mockResolvedValueOnce(res(200));
      const p = withRetry(requestFn, getToken, { throttle: noThrottle, maxRetries: 3 });
      await vi.runAllTimersAsync();
      const out = await p;
      expect(out.status).toBe(200);
      expect(requestFn).toHaveBeenCalledTimes(2);
    });

    it("honors Retry-After on 429", async () => {
      const getToken = vi.fn().mockResolvedValue("t");
      const requestFn = vi
        .fn()
        .mockResolvedValueOnce(res(429, { "retry-after": "2" }))
        .mockResolvedValueOnce(res(200));
      const p = withRetry(requestFn, getToken, { throttle: noThrottle, maxRetries: 3 });
      await vi.advanceTimersByTimeAsync(1999);
      expect(requestFn).toHaveBeenCalledTimes(1); // hasn't retried yet
      await vi.advanceTimersByTimeAsync(2);
      const out = await p;
      expect(out.status).toBe(200);
    });

    it("returns the last 5xx after exhausting retries", async () => {
      const getToken = vi.fn().mockResolvedValue("t");
      const requestFn = vi.fn().mockResolvedValue(res(503));
      const p = withRetry(requestFn, getToken, { throttle: noThrottle, maxRetries: 2 });
      await vi.runAllTimersAsync();
      const out = await p;
      expect(out.status).toBe(503);
      expect(requestFn).toHaveBeenCalledTimes(3); // attempts 0,1,2
    });
  });
});

describe("createThrottle", () => {
  it("serializes callers so each waits for the previous slot", async () => {
    vi.useFakeTimers();
    const throttle = createThrottle(100);
    const order: number[] = [];
    const a = throttle().then(() => order.push(1));
    const b = throttle().then(() => order.push(2));
    const c = throttle().then(() => order.push(3));
    await vi.runAllTimersAsync();
    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
    vi.useRealTimers();
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const p = sleep(50).then(done);
    await vi.advanceTimersByTimeAsync(50);
    await p;
    expect(done).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("createKeyedThrottle", () => {
  it("serializes callers sharing the same key", async () => {
    vi.useFakeTimers();
    const keyed = createKeyedThrottle(100);
    const throttleA = keyed("portal-a");
    const order: number[] = [];
    const a = throttleA().then(() => order.push(1));
    const b = throttleA().then(() => order.push(2));
    await vi.runAllTimersAsync();
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2]);
    vi.useRealTimers();
  });

  it("memoizes one throttle instance per key (same key -> same function)", () => {
    const keyed = createKeyedThrottle(50);
    expect(keyed("x")).toBe(keyed("x"));
    expect(keyed("x")).not.toBe(keyed("y"));
  });

  it("lets independent keys proceed without waiting on each other", async () => {
    const keyed = createKeyedThrottle(1_000_000); // huge spacing — would hang if shared
    const throttleA = keyed("a");
    const throttleB = keyed("b");
    // First call on each key resolves immediately regardless of spacing (only
    // subsequent calls on the SAME key wait for the prior slot).
    await Promise.race([
      Promise.all([throttleA(), throttleB()]),
      sleep(50).then(() => Promise.reject(new Error("timed out — keys are not independent"))),
    ]);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves result order regardless of completion order", async () => {
    const items = [30, 10, 20];
    const out = await mapWithConcurrency(items, 3, async (ms, i) => {
      await sleep(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it("bounds actual concurrency to the given limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("clamps a limit < 1 up to 1 (fully sequential)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3], 0, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(1);
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBe(1);
  });

  it("propagates a rejection from fn", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      })
    ).rejects.toThrow("boom");
  });

  it("returns an empty array for empty input", async () => {
    const out = await mapWithConcurrency([], 5, async (i) => i);
    expect(out).toEqual([]);
  });
});
