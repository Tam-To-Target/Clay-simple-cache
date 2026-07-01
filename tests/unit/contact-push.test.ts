import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/prisma", () => ({
  default: {
    contactClient: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("../../src/crm/registry", () => ({ getCrmAdapter: vi.fn() }));

vi.mock("../../src/services/dnc.service", () => ({
  dncService: { findMatch: vi.fn().mockResolvedValue(null) },
  normalizeCheckIdentifiers: vi.fn((x: any) => x),
}));

import prisma from "../../src/db/prisma";
import { getCrmAdapter } from "../../src/crm/registry";
import { dncService } from "../../src/services/dnc.service";
import { contactPushService } from "../../src/services/contact-push.service";

const mp = prisma as any;
const mAdapter = { platform: "hubspot", upsertContact: vi.fn() };
const CLIENT = { id: "c1", external_id: "acme", hubspot_portal_id: "p1" } as any;

beforeEach(() => {
  vi.clearAllMocks();
  (getCrmAdapter as any).mockReturnValue(mAdapter);
  (dncService.findMatch as any).mockResolvedValue(null);
  mp.contactClient.upsert.mockResolvedValue({});
});

describe("upsertPushLink", () => {
  it("creates the link tagged source='pushed' with the given status + properties", async () => {
    await contactPushService.upsertPushLink({
      clientId: "c1",
      contactId: "ct1",
      status: "pending",
      properties: { email: "a@b.com" },
      checkDnc: true,
    });
    const arg = mp.contactClient.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ contact_id_client_id: { contact_id: "ct1", client_id: "c1" } });
    expect(arg.create.source).toBe("pushed");
    expect(arg.create.push_status).toBe("pending");
    expect(arg.create.push_properties).toEqual({ email: "a@b.com" });
    expect(arg.update.push_status).toBe("pending");
  });
});

describe("backfillClient", () => {
  const rows = (over: any = {}) => [
    {
      contact_id: "ct1",
      contact: { email: "a@b.com" },
      push_properties: { email: "a@b.com", campaign_name: "x" },
      push_check_dnc: false,
      ...over,
    },
  ];

  it("errors out when the client has no portal", async () => {
    const r = await contactPushService.backfillClient({ ...CLIENT, hubspot_portal_id: null });
    expect(r.error).toMatch(/no hubspot_portal_id/);
    expect(mp.contactClient.findMany).not.toHaveBeenCalled();
  });

  it("pushes a pending lead and flips it to pushed", async () => {
    mp.contactClient.findMany.mockResolvedValue(rows());
    mAdapter.upsertContact.mockResolvedValue({ ok: true, action: "created", externalId: "h9" });

    const r = await contactPushService.backfillClient(CLIENT);
    expect(r.candidates).toBe(1);
    expect(r.created).toBe(1);
    const upsertArg = mp.contactClient.upsert.mock.calls[0][0];
    expect(upsertArg.update.push_status).toBe("pushed");
    expect(upsertArg.update.hubspot_contact_id).toBe("h9");
  });

  it("re-checks DNC and marks a now-suppressed lead skipped_dnc (no push)", async () => {
    mp.contactClient.findMany.mockResolvedValue(rows({ push_check_dnc: true }));
    (dncService.findMatch as any).mockResolvedValue({ matchedOn: "email", matchedValue: "a@b.com", entry: {} });

    const r = await contactPushService.backfillClient(CLIENT);
    expect(r.skipped_dnc).toBe(1);
    expect(mAdapter.upsertContact).not.toHaveBeenCalled();
    expect(mp.contactClient.upsert.mock.calls[0][0].update.push_status).toBe("skipped_dnc");
  });

  it("dry_run pushes nothing and writes nothing", async () => {
    mp.contactClient.findMany.mockResolvedValue(rows());
    const r = await contactPushService.backfillClient(CLIENT, { dryRun: true });
    expect(r.results[0].outcome).toBe("would_push");
    expect(mAdapter.upsertContact).not.toHaveBeenCalled();
    expect(mp.contactClient.upsert).not.toHaveBeenCalled();
  });

  it("keeps a lead pending when the CRM is still not connected", async () => {
    mp.contactClient.findMany.mockResolvedValue(rows());
    mAdapter.upsertContact.mockResolvedValue({ ok: false, notConnected: true, retryable: false, code: 401, error: "no grant" });

    const r = await contactPushService.backfillClient(CLIENT);
    expect(r.still_pending).toBe(1);
    expect(r.failed).toBe(0);
    expect(mp.contactClient.upsert.mock.calls[0][0].update.push_status).toBe("pending");
  });

  it("marks a lead failed on a transient error", async () => {
    mp.contactClient.findMany.mockResolvedValue(rows());
    mAdapter.upsertContact.mockResolvedValue({ ok: false, retryable: true, code: 500, error: "boom" });

    const r = await contactPushService.backfillClient(CLIENT);
    expect(r.failed).toBe(1);
    expect(mp.contactClient.upsert.mock.calls[0][0].update.push_status).toBe("failed");
  });

  it("fails a lead that has no stored properties to replay", async () => {
    mp.contactClient.findMany.mockResolvedValue(rows({ push_properties: {} }));
    const r = await contactPushService.backfillClient(CLIENT);
    expect(r.failed).toBe(1);
    expect(mAdapter.upsertContact).not.toHaveBeenCalled();
  });
});
