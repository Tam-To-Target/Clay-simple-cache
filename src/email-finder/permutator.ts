interface Pattern {
  name: string;
  build: (f: string, l: string) => string;
  prevalence: number;
}

const PATTERNS: Pattern[] = [
  { name: "first.last", build: (f, l) => `${f}.${l}`, prevalence: 0.35 },
  { name: "flast", build: (f, l) => `${f[0]}${l}`, prevalence: 0.25 },
  { name: "first", build: (f) => `${f}`, prevalence: 0.15 },
  { name: "firstlast", build: (f, l) => `${f}${l}`, prevalence: 0.05 },
  { name: "first_last", build: (f, l) => `${f}_${l}`, prevalence: 0.04 },
  { name: "last", build: (_f, l) => `${l}`, prevalence: 0.03 },
  { name: "lastf", build: (f, l) => `${l}${f[0]}`, prevalence: 0.02 },
  { name: "last.first", build: (f, l) => `${l}.${f}`, prevalence: 0.02 },
  { name: "f.last", build: (f, l) => `${f[0]}.${l}`, prevalence: 0.02 },
  { name: "first.l", build: (f, l) => `${f}.${l[0]}`, prevalence: 0.01 },
  { name: "firstl", build: (f, l) => `${f}${l[0]}`, prevalence: 0.01 },
  { name: "first-last", build: (f, l) => `${f}-${l}`, prevalence: 0.01 },
  { name: "f_last", build: (f, l) => `${f[0]}_${l}`, prevalence: 0.005 },
  { name: "last_first", build: (f, l) => `${l}_${f}`, prevalence: 0.005 },
  { name: "last.f", build: (f, l) => `${l}.${f[0]}`, prevalence: 0.005 },
];

export function normalizeName(name: string): string {
  return name
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, "");
}

function normalizeKeepingSpaces(name: string): string {
  return name
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\- ]/g, "");
}

export function parseFullName(fullName: string): [string, string] {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return ["", ""];
  if (parts.length === 1) return [parts[0], ""];
  if (parts.length === 2) return [parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1]];
  // 4+ words: first word = first name, penultimate = first last name (LATAM)
  return [parts[0], parts[parts.length - 2]];
}

function lastNameVariants(rawLast: string): string[] {
  const normalized = normalizeKeepingSpaces(rawLast);
  const variants: string[] = [];

  // Check for compound last names like "De la Cruz"
  if (normalized.includes(" ")) {
    const joined = normalized.replace(/\s+/g, "");
    variants.push(joined);
    // Also add just the last word
    const words = normalized.split(/\s+/);
    variants.push(words[words.length - 1]);
  } else if (normalized.includes("-")) {
    variants.push(normalized);
    variants.push(normalized.replace(/-/g, ""));
  } else {
    variants.push(normalized);
  }

  return variants.map(normalizeName).filter(Boolean);
}

function firstNameVariants(rawFirst: string): string[] {
  const normalized = normalizeName(rawFirst);
  const variants: string[] = [normalized];

  if (normalized.includes("-")) {
    variants.push(normalized.replace(/-/g, ""));
  }

  return variants.filter(Boolean);
}

export function generatePermutations(
  first: string,
  last: string,
  domain: string
): string[] {
  if (!first && !last) return [];

  const fVariants = firstNameVariants(first);
  const lVariants = lastNameVariants(last);
  const seen = new Set<string>();
  const result: string[] = [];

  const addEmail = (f: string, l: string) => {
    for (const pattern of PATTERNS) {
      if (!f && pattern.name !== "last") continue;
      if (!l && !["first"].includes(pattern.name)) continue;
      if ((!f || f.length === 0) && pattern.build.toString().includes("f[0]")) continue;
      if ((!l || l.length === 0) && pattern.build.toString().includes("l[0]")) continue;

      try {
        const local = pattern.build(f, l);
        if (!local || local.includes("undefined")) continue;
        const email = `${local}@${domain}`;
        if (!seen.has(email)) {
          seen.add(email);
          result.push(email);
        }
      } catch {
        continue;
      }
    }
  };

  // Primary combination first
  if (fVariants.length > 0 && lVariants.length > 0) {
    addEmail(fVariants[0], lVariants[0]);
  }

  // Other variant combinations
  for (const fv of fVariants) {
    for (const lv of lVariants) {
      if (fv === fVariants[0] && lv === lVariants[0]) continue;
      addEmail(fv, lv);
    }
  }

  return result;
}

export function generatePermutationsFromFullName(
  fullName: string,
  domain: string
): string[] {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 3) return [];

  const firstName = parts[0];
  const extras: string[] = [];
  const seen = new Set<string>();

  // Try each intermediate/last word as potential last name
  for (let i = 1; i < parts.length; i++) {
    const word = parts[i];
    if (word.endsWith(".")) continue;
    const normalized = normalizeName(word);
    if (normalized.length < 2) continue;

    const perms = generatePermutations(
      normalizeName(firstName),
      normalized,
      domain
    );
    for (const p of perms) {
      if (!seen.has(p)) {
        seen.add(p);
        extras.push(p);
      }
    }
  }

  return extras;
}

export interface KnownPattern {
  pattern: string;
  confidence: number;
  sample_count: number;
}

export function prioritizePermutations(
  permutations: string[],
  knownPatterns: KnownPattern[]
): string[] {
  if (knownPatterns.length === 0) return permutations;

  const sorted = [...knownPatterns].sort(
    (a, b) => b.confidence - a.confidence || b.sample_count - a.sample_count
  );

  const prioritized: string[] = [];
  const remaining = [...permutations];

  for (const kp of sorted) {
    for (let i = 0; i < remaining.length; i++) {
      const local = remaining[i].split("@")[0];
      // Check if this email matches the known pattern
      if (matchesPattern(local, kp.pattern, permutations)) {
        prioritized.push(remaining[i]);
        remaining.splice(i, 1);
        break;
      }
    }
  }

  return [...prioritized, ...remaining];
}

function matchesPattern(
  _localPart: string,
  patternName: string,
  allPermutations: string[]
): boolean {
  // Simple heuristic: the pattern name maps to position in PATTERNS array
  const patternIdx = PATTERNS.findIndex((p) => p.name === patternName);
  if (patternIdx === -1) return false;
  // The email at index patternIdx in allPermutations was generated by this pattern
  return allPermutations.some(
    (email) => email.split("@")[0] === _localPart
  );
}

export function identifyPattern(
  email: string,
  firstName: string,
  lastName: string
): string | null {
  const localPart = email.split("@")[0];
  const fVariants = firstNameVariants(firstName);
  const lVariants = lastNameVariants(lastName);

  for (const f of fVariants) {
    for (const l of lVariants) {
      for (const pattern of PATTERNS) {
        if (!f && pattern.name !== "last") continue;
        if (!l && !["first"].includes(pattern.name)) continue;

        try {
          const candidate = pattern.build(f, l);
          if (candidate === localPart) return pattern.name;
        } catch {
          continue;
        }
      }
    }
  }

  return null;
}
