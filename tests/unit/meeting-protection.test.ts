import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db/prisma", () => ({
  default: {
    dncEntry: { findMany: vi.fn() },
  },
}));

vi.mock("../../src/services/hubspot-token.service", () => ({
  getValidToken: vi.fn(),
}));

import prisma from "../../src/db/prisma";
import { getValidToken } from "../../src/services/hubspot-token.service";
import {
  meetingProtectionConfigFromEnv,
  loadMeetingProtectedContactIds,
  type ProtectCandidate,
  type MeetingProtectionConfig,
} from "../../src/services/meeting-protection.service";

const mockPrisma = prisma as any;
const tokenMock = getValidToken as any;

const client = (over: Partial<any> = {}) =>
  ({
    id: "client-1",
    hubspot_portal_id: "12345",
    ...over,
  } as any);

const cfg = (over: Partial<MeetingProtectionConfig> = {}): MeetingProtectionConfig => ({
  enabled: true,
  property: "meeting_scheduled_date",
  windowDays: 7,
  ...over,
});

const dncRow = (over: Partial<any> = {}) => ({
  email: null,
  phone_e164: null,
  data: {},
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("meetingProtectionConfigFromEnv", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to disabled with default property/window when env unset", () => {
    delete process.env.MEETING_PROTECTION_ENABLED;
    delete process.env.MEETING_PROTECTION_PROPERTY;
    delete process.env.MEETING_PROTECTION_WINDOW_DAYS;
    const c = meetingProtectionConfigFromEnv();
    expect(c.enabled).toBe(false);
    expect(c.property).toBe("meeting_scheduled_date");
    expect(c.windowDays).toBe(7);
  });

  it("reads enabled=true, custom property, and custom window from env", () => {
    process.env.MEETING_PROTECTION_ENABLED = "true";
    process.env.MEETING_PROTECTION_PROPERTY = "custom_meeting_date";
    process.env.MEETING_PROTECTION_WINDOW_DAYS = "14";
    const c = meetingProtectionConfigFromEnv();
    expect(c.enabled).toBe(true);
    expect(c.property).toBe("custom_meeting_date");
    expect(c.windowDays).toBe(14);
  });

  it("falls back to windowDays=7 when env value is not finite or <= 0", () => {
    process.env.MEETING_PROTECTION_WINDOW_DAYS = "not-a-number";
    expect(meetingProtectionConfigFromEnv().windowDays).toBe(7);
    process.env.MEETING_PROTECTION_WINDOW_DAYS = "0";
    expect(meetingProtectionConfigFromEnv().windowDays).toBe(7);
    process.env.MEETING_PROTECTION_WINDOW_DAYS = "-5";
    expect(meetingProtectionConfigFromEnv().windowDays).toBe(7);
  });

  it("applies overrides on top of env", () => {
    delete process.env.MEETING_PROTECTION_ENABLED;
    const c = meetingProtectionConfigFromEnv({ enabled: true, windowDays: 3 });
    expect(c.enabled).toBe(true);
    expect(c.windowDays).toBe(3);
  });
});

describe("loadMeetingProtectedContactIds", () => {
  const candidates: ProtectCandidate[] = [
    { pbContactId: "pb1", emails: ["a@example.com"], phones: [] },
  ];

  it("returns empty when disabled", async () => {
    const result = await loadMeetingProtectedContactIds(client(), candidates, cfg({ enabled: false }));
    expect(result).toEqual({ protectedIds: new Set(), readErrors: 0 });
    expect(mockPrisma.dncEntry.findMany).not.toHaveBeenCalled();
  });

  it("returns empty when candidates is empty", async () => {
    const result = await loadMeetingProtectedContactIds(client(), [], cfg());
    expect(result).toEqual({ protectedIds: new Set(), readErrors: 0 });
    expect(mockPrisma.dncEntry.findMany).not.toHaveBeenCalled();
  });

  it("returns empty when client has no hubspot_portal_id", async () => {
    const result = await loadMeetingProtectedContactIds(
      client({ hubspot_portal_id: null }),
      candidates,
      cfg()
    );
    expect(result).toEqual({ protectedIds: new Set(), readErrors: 0 });
    expect(mockPrisma.dncEntry.findMany).not.toHaveBeenCalled();
  });

  it("protects a candidate whose contact has a future meeting date (ISO string)", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      dncRow({ email: "a@example.com", data: { hubspot_contact_id: "hs1" } }),
    ]);
    const batchRead = vi.fn().mockResolvedValue(
      new Map([["hs1", { meeting_scheduled_date: new Date("2026-08-01T00:00:00Z").toISOString() }]])
    );
    const now = new Date("2026-07-15T00:00:00Z");

    const result = await loadMeetingProtectedContactIds(client(), candidates, cfg(), {
      now,
      batchRead,
    });

    expect(result.readErrors).toBe(0);
    expect(result.protectedIds).toEqual(new Set(["pb1"]));
    expect(batchRead).toHaveBeenCalledWith(expect.any(Function), ["hs1"], ["meeting_scheduled_date"]);
  });

  it("does NOT protect a candidate whose meeting date is older than the window", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      dncRow({ email: "a@example.com", data: { hubspot_contact_id: "hs1" } }),
    ]);
    const now = new Date("2026-07-15T00:00:00Z");
    // 10 days before now, window is 7 days -> outside window.
    const oldDate = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    const batchRead = vi.fn().mockResolvedValue(new Map([["hs1", { meeting_scheduled_date: oldDate }]]));

    const result = await loadMeetingProtectedContactIds(client(), candidates, cfg(), { now, batchRead });

    expect(result).toEqual({ protectedIds: new Set(), readErrors: 0 });
  });

  it("protects a candidate whose meeting date is within the window", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      dncRow({ email: "a@example.com", data: { hubspot_contact_id: "hs1" } }),
    ]);
    const now = new Date("2026-07-15T00:00:00Z");
    // 2 days before now, window is 7 days -> in window.
    const recentDate = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const batchRead = vi.fn().mockResolvedValue(new Map([["hs1", { meeting_scheduled_date: recentDate }]]));

    const result = await loadMeetingProtectedContactIds(client(), candidates, cfg(), { now, batchRead });

    expect(result.protectedIds).toEqual(new Set(["pb1"]));
    expect(result.readErrors).toBe(0);
  });

  it("does not protect a candidate with no matching dnc_entry (no resolvable contact id)", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([]);
    const batchRead = vi.fn();

    const result = await loadMeetingProtectedContactIds(client(), candidates, cfg(), { batchRead });

    expect(result).toEqual({ protectedIds: new Set(), readErrors: 0 });
    expect(batchRead).not.toHaveBeenCalled();
  });

  it("does not protect a candidate whose dnc_entry has no hubspot_contact_id in data", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      dncRow({ email: "a@example.com", data: { some_other_field: "x" } }),
    ]);
    const batchRead = vi.fn();

    const result = await loadMeetingProtectedContactIds(client(), candidates, cfg(), { batchRead });

    expect(result).toEqual({ protectedIds: new Set(), readErrors: 0 });
    expect(batchRead).not.toHaveBeenCalled();
  });

  it("fail-closed: protects all resolvable candidates and counts readErrors when batchRead throws", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      dncRow({ email: "a@example.com", data: { hubspot_contact_id: "hs1" } }),
    ]);
    const batchRead = vi.fn().mockRejectedValue(new Error("HubSpot batch read failed: HTTP 500"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await loadMeetingProtectedContactIds(client(), candidates, cfg(), { batchRead });

    expect(result.protectedIds).toEqual(new Set(["pb1"]));
    expect(result.readErrors).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("parses epoch-ms string property values", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      dncRow({ email: "a@example.com", data: { hubspot_contact_id: "hs1" } }),
    ]);
    const now = new Date("2026-07-15T00:00:00Z");
    const futureMs = now.getTime() + 5 * 86_400_000;
    const batchRead = vi.fn().mockResolvedValue(new Map([["hs1", { meeting_scheduled_date: String(futureMs) }]]));

    const result = await loadMeetingProtectedContactIds(client(), candidates, cfg(), { now, batchRead });

    expect(result.protectedIds).toEqual(new Set(["pb1"]));
  });

  it("parses ISO date string property values", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      dncRow({ email: "a@example.com", data: { hubspot_contact_id: "hs1" } }),
    ]);
    const now = new Date("2026-07-15T00:00:00Z");
    const batchRead = vi.fn().mockResolvedValue(
      new Map([["hs1", { meeting_scheduled_date: "2026-07-20T10:00:00.000Z" }]])
    );

    const result = await loadMeetingProtectedContactIds(client(), candidates, cfg(), { now, batchRead });

    expect(result.protectedIds).toEqual(new Set(["pb1"]));
  });

  it("protects both candidates when two candidates map to the same contactId", async () => {
    const twoCandidates: ProtectCandidate[] = [
      { pbContactId: "pb1", emails: ["a@example.com"], phones: [] },
      { pbContactId: "pb2", emails: [], phones: ["+15551234567"] },
    ];
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      dncRow({ email: "a@example.com", data: { hubspot_contact_id: "hs1" } }),
      dncRow({ phone_e164: "+15551234567", data: { hubspot_contact_id: "hs1" } }),
    ]);
    const now = new Date("2026-07-15T00:00:00Z");
    const batchRead = vi.fn().mockResolvedValue(
      new Map([["hs1", { meeting_scheduled_date: new Date(now.getTime() + 86_400_000).toISOString() }]])
    );

    const result = await loadMeetingProtectedContactIds(client(), twoCandidates, cfg(), { now, batchRead });

    expect(result.protectedIds).toEqual(new Set(["pb1", "pb2"]));
    expect(batchRead).toHaveBeenCalledWith(expect.any(Function), ["hs1"], ["meeting_scheduled_date"]);
  });

  it("uses the injected tokenProvider / getValidToken default without making a real HubSpot call", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      dncRow({ email: "a@example.com", data: { hubspot_contact_id: "hs1" } }),
    ]);
    tokenMock.mockResolvedValue("fake-token");
    const batchRead = vi.fn().mockResolvedValue(new Map());

    await loadMeetingProtectedContactIds(client(), candidates, cfg(), { batchRead });

    // The default tokenProvider (built from getValidToken) is passed to batchRead,
    // but batchRead itself is mocked, so getValidToken is never actually invoked.
    expect(tokenMock).not.toHaveBeenCalled();
    expect(batchRead).toHaveBeenCalled();
  });
});
