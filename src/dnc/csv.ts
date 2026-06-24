/**
 * Minimal RFC-4180-ish CSV parser (dependency-free).
 * Handles: quoted fields, escaped quotes (""), commas/newlines inside quotes,
 * and CRLF or LF line endings. Returns an array of row objects keyed by header.
 */
export function parseCsv(input: string): Record<string, string>[] {
  const rows = parseCsvRows(input);
  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.trim());
  const records: Record<string, string>[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // Skip fully-empty lines
    if (row.length === 1 && row[0].trim() === "") continue;

    const record: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      record[headers[c]] = (row[c] ?? "").trim();
    }
    records.push(record);
  }

  return records;
}

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  // Strip a leading BOM if present.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // consume escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else if (ch === "\r") {
      // ignore — handled by the following \n (or trailing CR)
    } else {
      field += ch;
    }
  }

  // Flush the final field/row if the file doesn't end with a newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Resolve a logical column (email/phone/domain/reason) to an actual CSV header.
 * Uses an explicit map first, then falls back to common header names
 * (case-insensitive).
 */
const DEFAULT_HEADER_ALIASES: Record<string, string[]> = {
  email: ["email", "email address", "e-mail", "work email", "contact email"],
  phone: ["phone", "phone number", "phone_e164", "mobile", "mobile phone", "telephone", "tel"],
  domain: ["domain", "company domain", "website", "web", "url"],
  reason: ["reason", "dnc reason", "do not contact reason", "notes", "note"],
};

export function resolveColumn(
  headers: string[],
  logical: "email" | "phone" | "domain" | "reason",
  explicitMap?: Record<string, string>
): string | null {
  const explicit = explicitMap?.[logical];
  if (explicit && headers.includes(explicit)) return explicit;

  const lowerHeaders = headers.map((h) => h.toLowerCase());
  for (const alias of DEFAULT_HEADER_ALIASES[logical]) {
    const idx = lowerHeaders.indexOf(alias);
    if (idx !== -1) return headers[idx];
  }
  return null;
}
