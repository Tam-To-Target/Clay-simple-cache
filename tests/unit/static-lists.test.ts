import { describe, it, expect } from "vitest";
import {
  checkDisposable,
  checkFreeProvider,
  checkRoleAccount,
} from "../../src/email-finder/static-lists";

describe("checkDisposable", () => {
  it("detects known disposable domains", () => {
    expect(checkDisposable("mailinator.com")).toBe(true);
    expect(checkDisposable("guerrillamail.com")).toBe(true);
  });

  it("does not flag legitimate domains", () => {
    expect(checkDisposable("google.com")).toBe(false);
    expect(checkDisposable("microsoft.com")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(checkDisposable("MAILINATOR.COM")).toBe(true);
  });
});

describe("checkFreeProvider", () => {
  it("detects known free providers", () => {
    expect(checkFreeProvider("gmail.com")).toBe(true);
    expect(checkFreeProvider("yahoo.com")).toBe(true);
    expect(checkFreeProvider("hotmail.com")).toBe(true);
  });

  it("does not flag business domains", () => {
    expect(checkFreeProvider("acme.com")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(checkFreeProvider("GMAIL.COM")).toBe(true);
  });
});

describe("checkRoleAccount", () => {
  it("detects common role accounts", () => {
    expect(checkRoleAccount("info")).toBe(true);
    expect(checkRoleAccount("admin")).toBe(true);
    expect(checkRoleAccount("support")).toBe(true);
    expect(checkRoleAccount("sales")).toBe(true);
  });

  it("does not flag personal names", () => {
    expect(checkRoleAccount("john")).toBe(false);
    expect(checkRoleAccount("jdoe")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(checkRoleAccount("INFO")).toBe(true);
  });
});
