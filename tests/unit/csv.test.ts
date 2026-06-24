import { describe, it, expect } from "vitest";
import { parseCsv, resolveColumn } from "../../src/dnc/csv";

describe("parseCsv", () => {
  it("parses a simple CSV into row objects", () => {
    const rows = parseCsv("email,reason\na@b.com,opted out\nc@d.com,bounced");
    expect(rows).toEqual([
      { email: "a@b.com", reason: "opted out" },
      { email: "c@d.com", reason: "bounced" },
    ]);
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('email,reason\n"a@b.com","said ""no, thanks"""');
    expect(rows[0].email).toBe("a@b.com");
    expect(rows[0].reason).toBe('said "no, thanks"');
  });

  it("handles CRLF line endings and a trailing newline", () => {
    const rows = parseCsv("email\r\na@b.com\r\n");
    expect(rows).toEqual([{ email: "a@b.com" }]);
  });

  it("strips a UTF-8 BOM", () => {
    const rows = parseCsv("﻿email\na@b.com");
    expect(rows[0].email).toBe("a@b.com");
  });

  it("skips fully empty lines", () => {
    const rows = parseCsv("email\na@b.com\n\n");
    expect(rows).toHaveLength(1);
  });

  it("returns [] for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("resolveColumn", () => {
  const headers = ["Email Address", "Phone Number", "Company Domain", "Notes"];

  it("matches common aliases case-insensitively", () => {
    expect(resolveColumn(headers, "email")).toBe("Email Address");
    expect(resolveColumn(headers, "phone")).toBe("Phone Number");
    expect(resolveColumn(headers, "domain")).toBe("Company Domain");
    expect(resolveColumn(headers, "reason")).toBe("Notes");
  });

  it("prefers an explicit column map", () => {
    expect(resolveColumn(["correo", "email"], "email", { email: "correo" })).toBe("correo");
  });

  it("returns null when no column matches", () => {
    expect(resolveColumn(["foo", "bar"], "email")).toBeNull();
  });
});
