import fs from "fs";
import path from "path";

function loadSet(filename: string): Set<string> {
  const filepath = path.join(process.cwd(), "data", filename);
  try {
    const content = fs.readFileSync(filepath, "utf-8");
    return new Set(
      content
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean)
    );
  } catch {
    console.warn(`Warning: could not load ${filepath}`);
    return new Set();
  }
}

const disposableDomains = loadSet("disposable_domains.txt");
const freeProviders = loadSet("free_providers.txt");
const roleAccounts = loadSet("role_accounts.txt");

export function checkDisposable(domain: string): boolean {
  return disposableDomains.has(domain.toLowerCase());
}

export function checkFreeProvider(domain: string): boolean {
  return freeProviders.has(domain.toLowerCase());
}

export function checkRoleAccount(localPart: string): boolean {
  return roleAccounts.has(localPart.toLowerCase());
}
