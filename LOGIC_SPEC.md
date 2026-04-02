# Email Finder — Especificacion Completa de Logica

Documento de referencia para reimplementar el sistema en cualquier lenguaje (TypeScript, Go, etc). Contiene toda la logica de negocio, algoritmos, estructuras de datos, APIs externas, y contratos de endpoints.

---

## Tabla de Contenidos

1. [Vision General](#1-vision-general)
2. [Tipos y Enums](#2-tipos-y-enums)
3. [Configuracion](#3-configuracion)
4. [Base de Datos (SQLite)](#4-base-de-datos-sqlite)
5. [Modulo: Permutator (Generacion de Emails)](#5-modulo-permutator)
6. [Modulo: Domain Intelligence](#6-modulo-domain-intelligence)
7. [Modulo: Providers (APIs de Verificacion)](#7-modulo-providers)
8. [Modulo: Pipeline (Orquestador Principal)](#8-modulo-pipeline)
9. [Modulo: Pattern Learner](#9-modulo-pattern-learner)
10. [API Endpoints](#10-api-endpoints)
11. [Servicios: Job Manager y File Processor](#11-servicios)
12. [UI Web](#12-ui-web)
13. [Datos Estaticos](#13-datos-estaticos)
14. [Notas de Implementacion](#14-notas-de-implementacion)

---

## 1. Vision General

**Input:** Nombre de persona + dominio de empresa
**Output:** Email verificado + nivel de confianza

### Flujo principal (find_email)

```
Input: { first_name, last_name, full_name, domain, max_tier }
  │
  ▼
1. Parsear nombre (full_name → first + last, con logica LATAM)
2. Normalizar nombres (remover acentos, lowercase)
3. Analizar dominio (MX, provider, disposable, free)
4. Early exit si: no_mx, disposable
5. Generar permutaciones de email (15 patrones + extras LATAM)
6. Aplicar patron conocido del dominio (si existe en DB)
7. Limitar a max_permutations_to_try (default: 15)
8. Revisar cache de verificaciones previas
9. Cascada de APIs (Tier 1 → Tier 2 → Tier 3)
   - Si encuentra "valid" → guardar patron, cachear, retornar
   - Si encuentra "catch_all" → retornar best-guess con confidence=0.5
   - Si encuentra "invalid" → detener, retornar
10. Si hay candidato "risky" → retornarlo
11. Si nada → retornar "unknown"
12. Loggear busqueda en DB
```

### Flujo de verificacion (verify_single_email)

```
Input: { email, max_tier }
  │
  ▼
1. Validar sintaxis (contiene @)
2. Revisar cache
3. Analizar dominio (MX, disposable)
4. Early exit si: no_mx, disposable
5. Cascada de APIs
6. Cachear resultado
7. Retornar
```

---

## 2. Tipos y Enums

### EmailStatus (string enum)

```typescript
enum EmailStatus {
  valid = "valid"           // Email existe y acepta correo
  invalid = "invalid"       // Email no existe
  catch_all = "catch_all"   // Dominio acepta todo, no verificable con certeza
  unknown = "unknown"       // No se pudo determinar
  risky = "risky"           // Probablemente existe pero con riesgo
  disposable = "disposable" // Dominio de email temporal
  no_mx = "no_mx"           // Dominio sin servidor de correo
  role_account = "role_account" // Email de rol (info@, admin@, etc)
}
```

### VerificationMethod (string enum)

```typescript
enum VerificationMethod {
  local_syntax = "local_syntax"
  local_dns = "local_dns"
  emaillistverify = "emaillistverify"
  debounce = "debounce"
  bouncer = "bouncer"
  neverbounce = "neverbounce"
}
```

### JobStatus (string enum)

```typescript
enum JobStatus {
  queued = "queued"
  processing = "processing"
  completed = "completed"
  failed = "failed"
}
```

### ProviderType (string enum)

```typescript
enum ProviderType {
  google_workspace = "google_workspace"
  office365 = "office365"
  yahoo = "yahoo"
  other = "other"
}
```

### DomainInfo

```typescript
interface DomainInfo {
  domain: string
  has_mx: boolean
  mx_records: string[]
  provider: ProviderType
  is_catch_all: boolean
  is_disposable: boolean
  is_free_provider: boolean
  smtp_verifiable: boolean  // false para google/o365/yahoo
}
```

### VerificationResult

```typescript
interface VerificationResult {
  email: string | null
  status: EmailStatus
  confidence: number        // 0.0 a 1.0
  method: VerificationMethod
  pattern: string | null    // ej: "first.last", "flast"
  domain_info: DomainInfo | null
  permutations_tried: number
  cost_usd: number
  duration_ms: number
}
```

### FindRequest

```typescript
interface FindRequest {
  first_name?: string
  last_name?: string
  domain: string            // requerido
  full_name?: string
  max_tier?: number         // 1, 2 o 3 (default: 3)
  force_premium?: boolean   // default: false
}
```

---

## 3. Configuracion

```typescript
interface Config {
  // API Keys
  emaillistverify_api_key: string   // Tier 1
  debounce_api_key: string          // Tier 2
  bouncer_api_key: string           // Tier 2 alt
  neverbounce_api_key: string       // Tier 3

  // Database
  database_path: string             // default: "db/email_finder.db"

  // Limites
  max_permutations_to_try: number   // default: 15

  // Cache TTL (segundos)
  domain_cache_ttl: number          // default: 604800 (7 dias)
  verification_cache_ttl: number    // default: 2592000 (30 dias)
}
```

Fuente: variables de entorno o archivo `.env`.

---

## 4. Base de Datos (SQLite)

### Tabla: verification_cache

Cachea resultados de verificacion de emails individuales.

```sql
CREATE TABLE verification_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL,            -- EmailStatus value
    confidence REAL DEFAULT 0.0,
    method TEXT,                     -- VerificationMethod value
    verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP             -- verificar de nuevo despues de esta fecha
);
CREATE INDEX idx_verification_cache_email ON verification_cache(email);
```

**TTL:** `verification_cache_ttl` (30 dias). Al consultar, filtrar por `expires_at > NOW()`.

### Tabla: domain_patterns

Patrones de email aprendidos por dominio. Se enriquece con cada email verificado exitosamente.

```sql
CREATE TABLE domain_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    pattern TEXT NOT NULL,            -- ej: "first.last", "flast"
    confidence REAL DEFAULT 1.0,     -- sube con cada confirmacion (+0.1, max 1.0)
    sample_count INTEGER DEFAULT 1,  -- cuantas veces se confirmo
    last_confirmed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(domain, pattern)
);
CREATE INDEX idx_domain_patterns_domain ON domain_patterns(domain);
```

**Upsert logic:** Si ya existe (domain, pattern), incrementar `sample_count` y `confidence`:
```sql
ON CONFLICT(domain, pattern) DO UPDATE SET
  sample_count = sample_count + 1,
  confidence = MIN(1.0, confidence + 0.1),
  last_confirmed = CURRENT_TIMESTAMP
```

### Tabla: domain_intel

Cache de inteligencia de dominio (MX, provider, catch-all, etc).

```sql
CREATE TABLE domain_intel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE NOT NULL,
    has_mx BOOLEAN DEFAULT 0,
    mx_records TEXT DEFAULT '[]',     -- JSON array de strings
    provider TEXT DEFAULT 'other',    -- ProviderType value
    is_catch_all BOOLEAN DEFAULT 0,
    is_disposable BOOLEAN DEFAULT 0,
    is_free_provider BOOLEAN DEFAULT 0,
    checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP              -- re-check despues de 7 dias
);
CREATE INDEX idx_domain_intel_domain ON domain_intel(domain);
```

### Tabla: search_log

Log de cada busqueda realizada. Para metricas.

```sql
CREATE TABLE search_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT,
    last_name TEXT,
    domain TEXT,
    result_email TEXT,
    result_status TEXT,
    method_used TEXT,
    permutations_tried INTEGER DEFAULT 0,
    api_calls_made INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0.0,
    duration_ms INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_search_log_domain ON search_log(domain);
```

### Tabla: batch_jobs

Trabajos batch en proceso.

```sql
CREATE TABLE batch_jobs (
    id TEXT PRIMARY KEY,              -- UUID
    status TEXT DEFAULT 'queued',     -- JobStatus value
    total_contacts INTEGER DEFAULT 0,
    completed_contacts INTEGER DEFAULT 0,
    results TEXT DEFAULT '[]',        -- JSON array de BatchResultItem
    webhook_url TEXT,
    total_cost_usd REAL DEFAULT 0.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);
```

### Tabla: uploaded_files

Metadata de archivos CSV/XLSX subidos.

```sql
CREATE TABLE uploaded_files (
    id TEXT PRIMARY KEY,              -- UUID
    original_filename TEXT,
    stored_path TEXT,
    columns TEXT DEFAULT '[]',        -- JSON array de strings
    rows_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 5. Modulo: Permutator

### 5.1 Normalizacion de nombres

**Funcion: `normalize_name(name: string) → string`**

1. Strip whitespace
2. NFD Unicode decomposition → remover caracteres combinantes (acentos)
   - "Garcia" → "garcia", "Jose" → "jose", "Muller" → "muller"
3. Lowercase
4. Remover todo excepto `a-z`, `0-9`, `-`
   - Regex: `[^a-z0-9\-]` → ""

**Funcion: `normalize_keeping_spaces(name: string) → string`**
- Igual pero preserva espacios internos (para procesar antes de join)
- Regex: `[^a-z0-9\- ]` → ""

### 5.2 Parseo de nombre completo (logica LATAM)

**Funcion: `parse_full_name(full_name: string) → [first, last]`**

Estructura tipica LATAM: `[Nombre] [Segundo Nombre] [Primer Apellido] [Segundo Apellido]`

```
1 palabra:  "Juan"                    → ["Juan", ""]
2 palabras: "Juan Garcia"             → ["Juan", "Garcia"]
3 palabras: "Julio Perochena Garcia"  → ["Julio", "Perochena"]   ← segundo word = primer apellido
4+ palabras: "Jose Alberto Leal Osorio" → ["Jose", "Leal"]      ← penultimo word = primer apellido
```

**Logica adicional en el pipeline:** Cuando el CSV provee `first_name` y `last_name` directamente, pero `full_name` tiene 3+ palabras, el pipeline re-parsea el full_name. Si el apellido parseado difiere del Last Name del CSV, usa el parseado (primer apellido) como primario:

```
CSV: First="Vicente" Last="Morientes" Full="Vicente Galindo Morientes"
  → parse_full_name → ("Vicente", "Galindo")
  → "Galindo" ≠ "Morientes" → usar "Galindo" como last
```

### 5.3 Variantes de nombre

**Funcion: `last_name_variants(raw_last: string) → string[]`**

- Simple: "Garcia" → ["garcia"]
- Compuesto: "De la Cruz" → ["delacruz", "cruz"]
- Hyphenado: "Jean-Pierre" → ["jean-pierre", "jeanpierre"]

**Funcion: `first_name_variants(raw_first: string) → string[]`**

- Simple: "Juan" → ["juan"]
- Hyphenado: "Jean-Pierre" → ["jean-pierre", "jeanpierre"]

### 5.4 Patrones de email (ordenados por prevalencia)

```typescript
const PATTERNS = [
  { name: "first.last",  build: (f, l) => `${f}.${l}`,        prevalence: 0.35 },
  { name: "flast",       build: (f, l) => `${f[0]}${l}`,      prevalence: 0.25 },
  { name: "first",       build: (f, l) => `${f}`,             prevalence: 0.15 },
  { name: "firstlast",   build: (f, l) => `${f}${l}`,         prevalence: 0.05 },
  { name: "first_last",  build: (f, l) => `${f}_${l}`,        prevalence: 0.04 },
  { name: "last",        build: (f, l) => `${l}`,             prevalence: 0.03 },
  { name: "lastf",       build: (f, l) => `${l}${f[0]}`,      prevalence: 0.02 },
  { name: "last.first",  build: (f, l) => `${l}.${f}`,        prevalence: 0.02 },
  { name: "f.last",      build: (f, l) => `${f[0]}.${l}`,     prevalence: 0.02 },
  { name: "first.l",     build: (f, l) => `${f}.${l[0]}`,     prevalence: 0.01 },
  { name: "firstl",      build: (f, l) => `${f}${l[0]}`,      prevalence: 0.01 },
  { name: "first-last",  build: (f, l) => `${f}-${l}`,        prevalence: 0.01 },
  { name: "f_last",      build: (f, l) => `${f[0]}_${l}`,     prevalence: 0.005 },
  { name: "last_first",  build: (f, l) => `${l}_${f}`,        prevalence: 0.005 },
  { name: "last.f",      build: (f, l) => `${l}.${f[0]}`,     prevalence: 0.005 },
]
```

### 5.5 Generacion de permutaciones

**Funcion: `generate_permutations(first, last, domain) → string[]`**

1. Obtener variantes de first y last
2. Para la combinacion primaria (first_variants[0], last_variants[0]): generar 15 emails con los patrones
3. Para cada otra combinacion de variantes: generar 15 emails mas
4. Deduplicar preservando orden de prevalencia
5. Retornar lista unica

**Funcion: `generate_permutations_from_full_name(full_name, domain) → string[]`**

Para nombres LATAM de 3+ palabras, generar permutaciones extras probando CADA palabra intermedia como posible apellido:

```
"Jose Alberto Leal Osorio" genera extras con:
  - (Jose, Alberto)
  - (Jose, Leal)
  - (Jose, Osorio)
```

Reglas:
- Saltar palabras que terminan en "." (abreviaciones como "G.")
- Saltar palabras con menos de 2 caracteres despues de normalizar
- Deduplicar contra las permutaciones base

### 5.6 Priorizacion por patron conocido

**Funcion: `prioritize_permutations(permutations, known_patterns) → string[]`**

Si la DB tiene patrones conocidos para el dominio (de busquedas previas exitosas):
1. Ordenar known_patterns por confidence DESC, sample_count DESC
2. Para cada patron conocido, encontrar el email correspondiente en las permutaciones
3. Mover esos emails al inicio de la lista
4. Mantener el resto en orden original

### 5.7 Identificacion de patron (reversa)

**Funcion: `identify_pattern(email, first_name, last_name) → string | null`**

Dado un email verificado, determinar que patron se uso:
1. Extraer local part (antes del @)
2. Para cada combinacion de variantes de first/last:
   - Para cada patron: generar el local part candidato
   - Si coincide con el local part del email → retornar nombre del patron
3. Si ninguno coincide → null

---

## 6. Modulo: Domain Intelligence

### 6.1 Analisis de dominio

**Funcion: `analyze_domain(domain) → DomainInfo`**

1. **Cache check:** Buscar en `domain_intel` donde `expires_at > NOW()`
   - Si existe → retornar como DomainInfo
2. **MX Lookup:** Resolver DNS MX records
   - Ordenar por prioridad (preference ascendente)
   - Extraer hostnames sin trailing dot
   - Si no hay MX → `has_mx = false`
3. **Detectar provider:** Analizar MX hostnames:
   - Contiene "google.com" o "googlemail.com" → `google_workspace`
   - Contiene "outlook.com" o "protection.outlook.com" o "microsoft.com" → `office365`
   - Contiene "yahoo.com" o "yahoodns.net" → `yahoo`
   - Otro → `other`
4. **Disposable check:** Comparar dominio contra `data/disposable_domains.txt` (~500 dominios)
5. **Free provider check:** Comparar contra `data/free_providers.txt` (~40 dominios)
6. **SMTP verifiable:** `true` solo si provider == "other" (Gmail/O365/Yahoo aceptan todo)
7. **Cachear en DB** con TTL de 7 dias
8. **Retornar DomainInfo** (is_catch_all siempre false aqui — se detecta via API)

### 6.2 Deteccion de provider por MX

```typescript
function detect_provider(mx_records: string[]): ProviderType {
  const lowered = mx_records.map(mx => mx.toLowerCase())

  for (const mx of lowered) {
    if (mx.includes("google.com") || mx.includes("googlemail.com"))
      return "google_workspace"
  }
  for (const mx of lowered) {
    if (mx.includes("outlook.com") || mx.includes("protection.outlook.com") || mx.includes("microsoft.com"))
      return "office365"
  }
  for (const mx of lowered) {
    if (mx.includes("yahoo.com") || mx.includes("yahoodns.net"))
      return "yahoo"
  }
  return "other"
}
```

### 6.3 Verificaciones contra listas estaticas

Las listas se cargan de archivos de texto (una entrada por linea) y se cachean en memoria como Sets para lookup O(1):

- **`check_disposable(domain)`** → `data/disposable_domains.txt` (~500 dominios)
- **`check_free_provider(domain)`** → `data/free_providers.txt` (~40 dominios)
- **`check_role_account(local_part)`** → `data/role_accounts.txt` (~40 cuentas)

---

## 7. Modulo: Providers (APIs de Verificacion)

### 7.1 Interfaz base

Todos los providers implementan:

```typescript
interface EmailVerificationProvider {
  name: string
  cost_per_email: number   // USD
  method: VerificationMethod

  is_configured(): boolean    // API key presente?
  verify(email: string): Promise<VerificationResult>
}
```

### 7.2 Tier 1: EmailListVerify ($0.0004/email)

- **API:** `GET https://apps.emaillistverify.com/api/verifyEmail?secret={key}&email={email}`
- **Response:** Plain text, una palabra
- **Timeout:** 30 segundos

**Mapeo de respuestas:**

| Respuesta API | EmailStatus | Confidence |
|---|---|---|
| `ok` | valid | 0.95 |
| `fail` | invalid | 0.95 |
| `ok_for_all` | catch_all | 0.5 |
| `unknown` | unknown | 0.3 |
| `disposable` | disposable | 0.95 |
| `role` | role_account | 0.8 |
| `email_disabled` | invalid | 0.9 |
| `domain_error` | invalid | 0.9 |
| `error_credit` | unknown | 0.0 |
| `error` | unknown | 0.0 |
| (cualquier otro) | unknown | 0.3 |

**Manejo de creditos agotados:**
- Flag a nivel de modulo: `credits_exhausted = false`
- Al recibir "error_credit" o "error": activar flag
- Cuando el flag esta activo: retornar inmediatamente `unknown` con `cost_usd=0` sin llamar API
- No cobrar costo cuando la respuesta empieza con "error"

### 7.3 Tier 2: DeBounce ($0.0015/email)

- **API:** `GET https://api.debounce.io/v1/?api={key}&email={email}`
- **Response:** JSON
- **Timeout:** 30 segundos

```json
{
  "debounce": {
    "email": "...",
    "code": "5",
    "result": "Safe to Send",
    "reason": "Deliverable"
  }
}
```

**Mapeo:**

| `result` (lowercase) | EmailStatus | Confidence |
|---|---|---|
| `safe to send` | valid | 0.95 |
| `risky` | risky | 0.5 |
| `invalid` | invalid | 0.95 |
| `unknown` | unknown | 0.3 |

**Override:** Si `code == "4"` → catch_all (0.5), independiente del result.

### 7.4 Tier 2 alt: Bouncer ($0.003/email)

- **API:** `GET https://api.usebouncer.com/v1/email/verify?email={email}`
- **Headers:** `x-api-key: {key}`
- **Response:** JSON
- **Timeout:** 30 segundos

```json
{
  "email": "...",
  "status": "deliverable",
  "reason": "accepted_email"
}
```

**Mapeo:**

| `status` (lowercase) | EmailStatus | Confidence |
|---|---|---|
| `deliverable` | valid | 0.95 |
| `undeliverable` | invalid | 0.95 |
| `risky` | risky | 0.5 |
| `unknown` | unknown | 0.3 |

**Override:** Si `reason` contiene "accept_all" → catch_all (0.5).

### 7.5 Tier 3: NeverBounce ($0.008/email)

- **API:** `GET https://api.neverbounce.com/v4/single/check?key={key}&email={email}`
- **Response:** JSON
- **Timeout:** 30 segundos

```json
{
  "status": "success",
  "result": "valid",
  "flags": ["has_dns", "has_dns_mx"]
}
```

**Mapeo:**

| `result` (lowercase) | EmailStatus | Confidence |
|---|---|---|
| `valid` | valid | 0.97 |
| `invalid` | invalid | 0.97 |
| `disposable` | disposable | 0.95 |
| `catchall` | catch_all | 0.6 |
| `unknown` | unknown | 0.3 |

### 7.6 Manejo de errores (todos los providers)

Para cualquier excepcion (timeout, HTTP error, JSON parse error, etc):
- Retornar `status=unknown`, `confidence=0.3`
- No crashear nunca

---

## 8. Modulo: Pipeline (Orquestador Principal)

### 8.1 Cascada de APIs

```typescript
async function api_cascade(email: string, max_tier: number, force_premium: boolean): VerificationResult {
  const tiers = [
    [new EmailListVerifyProvider()],             // Tier 1
    [new DebounceProvider(), new BouncerProvider()], // Tier 2
    [new NeverBounceProvider()],                 // Tier 3
  ]

  let total_cost = 0

  for (let tier_idx = 0; tier_idx < tiers.length; tier_idx++) {
    if (tier_idx + 1 > max_tier) break
    if (tier_idx === 2 && !force_premium) break

    for (const provider of tiers[tier_idx]) {
      if (!provider.is_configured()) continue

      const result = await provider.verify(email)
      total_cost += result.cost_usd

      if (result.status in ["valid", "invalid", "catch_all"]) {
        result.cost_usd = total_cost
        return result
      }
    }
  }

  return { status: "unknown", cost_usd: total_cost }
}
```

**Logica clave:** Se detiene en el primer resultado CONCLUSIVO (valid, invalid, catch_all). Si es unknown o risky, sigue al siguiente provider/tier.

### 8.2 find_email — Flujo completo

```typescript
async function find_email(request: FindRequest): VerificationResult {
  const start = Date.now()
  let total_cost = 0
  let permutations_tried = 0
  let api_calls = 0

  // ── 1. Parse name ──
  let first = request.first_name || ""
  let last = request.last_name || ""

  if (request.full_name && !(first && last)) {
    [first, last] = parse_full_name(request.full_name)
  } else if (request.full_name && request.full_name.split(" ").length >= 3) {
    // Re-parsear para nombres LATAM donde CSV tiene segundo apellido
    const [parsed_first, parsed_last] = parse_full_name(request.full_name)
    if (parsed_last && normalize(parsed_last) !== normalize(last)) {
      last = parsed_last
    }
  }

  // ── 2. Normalize ──
  first = normalize_name(first)
  last = normalize_name(last)
  const domain = request.domain.trim().toLowerCase()

  // ── 3. Domain analysis ──
  const domain_info = await analyze_domain(domain)

  // ── 4. Early exits ──
  if (!domain_info.has_mx) return { status: "no_mx", ... }
  if (domain_info.is_disposable) return { status: "disposable", ... }

  // ── 5. Generate permutations ──
  let permutations = generate_permutations(first, last, domain)

  // Extra permutations from full name (LATAM compound names)
  if (request.full_name) {
    const extras = generate_permutations_from_full_name(request.full_name, domain)
    const seen = new Set(permutations)
    for (const e of extras) {
      if (!seen.has(e)) {
        seen.add(e)
        permutations.push(e)
      }
    }
  }

  // Apply known domain patterns
  const known_patterns = await get_domain_patterns(domain)
  permutations = prioritize_permutations(permutations, known_patterns)
  permutations = permutations.slice(0, config.max_permutations_to_try)

  // ── 6. Cache check ──
  for (const email of permutations) {
    const cached = await get_cached_verification(email)
    if (cached?.status === "valid") {
      return { email, status: "valid", confidence: cached.confidence, ... }
    }
  }

  // ── 7. API cascade ──
  let risky_candidate = null

  for (const email of permutations) {
    const result = await api_cascade(email, request.max_tier, request.force_premium)
    api_calls++
    total_cost += result.cost_usd
    permutations_tried++

    if (result.status === "valid") {
      const pattern = identify_pattern(email, first, last)
      if (pattern) await save_domain_pattern(domain, pattern)
      await cache_verification(email, "valid", result.confidence, result.method)
      await log_search(...)
      return { email, status: "valid", pattern, ... }
    }

    if (result.status === "invalid") {
      await log_search(...)
      return { status: "invalid", ... }
    }

    if (result.status === "catch_all") {
      // Best-guess: usar primera permutacion como email probable
      const best_guess = permutations[0]
      const pattern = identify_pattern(best_guess, first, last)
      await log_search(...)
      return { email: best_guess, status: "catch_all", confidence: 0.5, pattern, ... }
    }

    if (result.status === "risky" && !risky_candidate) {
      risky_candidate = { email, ...result }
    }
  }

  // ── 8. Return best available ──
  if (risky_candidate) {
    await log_search(...)
    return risky_candidate
  }

  await log_search(...)
  return { status: "unknown", ... }
}
```

### 8.3 verify_single_email

```typescript
async function verify_single_email(email: string, max_tier: number): VerificationResult {
  // 1. Syntax check
  if (!email.includes("@")) return { status: "invalid", confidence: 1.0 }

  const domain = email.split("@")[1]

  // 2. Cache check
  const cached = await get_cached_verification(email)
  if (cached) return cached

  // 3. Domain analysis
  const info = await analyze_domain(domain)
  if (!info.has_mx) return { status: "no_mx" }
  if (info.is_disposable) return { status: "disposable" }

  // 4. API cascade
  const result = await api_cascade(email, max_tier, max_tier >= 3)

  // 5. Cache and return
  if (result.status !== "unknown") {
    await cache_verification(email, result.status, result.confidence, result.method)
  }
  return result
}
```

---

## 9. Modulo: Pattern Learner

Dos funciones simples que wrappean la DB:

```typescript
async function learn_pattern(domain: string, pattern: string) {
  // Upsert en domain_patterns: incrementa sample_count y confidence
  await save_domain_pattern(domain, pattern)
}

async function get_best_pattern(domain: string): string | null {
  const patterns = await get_domain_patterns(domain) // sorted by confidence DESC
  return patterns.length > 0 ? patterns[0].pattern : null
}
```

---

## 10. API Endpoints

### POST /find/ — Buscar email individual

**Request:**
```json
{
  "first_name": "Juan",
  "last_name": "Garcia",
  "domain": "empresa.com",
  "full_name": "Juan Garcia",
  "max_tier": 3,
  "force_premium": false
}
```

**Response:**
```json
{
  "success": true,
  "email": "juan.garcia@empresa.com",
  "status": "valid",
  "confidence": 0.95,
  "method": "emaillistverify",
  "pattern": "first.last",
  "domain_info": { ... },
  "permutations_tried": 1,
  "cost_usd": 0.0004,
  "duration_ms": 983
}
```

### POST /find/batch — Buscar emails en lote

**Request:**
```json
{
  "contacts": [ FindRequest, ... ],
  "max_tier": 2,
  "webhook_url": "https://webhook.site/xxx"
}
```

**Response (inmediata, 202):**
```json
{
  "job_id": "uuid",
  "total_contacts": 100,
  "status": "queued",
  "results_url": "/jobs/{job_id}"
}
```

Procesa en background. Webhook se dispara al completar.

### GET /jobs/{job_id} — Estado de batch

**Response:**
```json
{
  "job_id": "uuid",
  "status": "completed",
  "progress": { "total": 100, "completed": 100, "valid": 15, "invalid": 51, "catch_all": 17, "unknown": 11 },
  "results": [ BatchResultItem, ... ],
  "total_cost_usd": 0.099,
  "duration_ms": 85000
}
```

### POST /verify/ — Verificar email existente

**Request:**
```json
{ "email": "juan@empresa.com", "max_tier": 2 }
```

**Response:**
```json
{
  "email": "juan@empresa.com",
  "status": "valid",
  "confidence": 0.95,
  "method": "emaillistverify",
  "domain_info": { ... },
  "cost_usd": 0.0004
}
```

### POST /verify/batch — Verificar lista de emails

Similar a /find/batch pero recibe `{ emails: string[], max_tier, webhook_url }`.

### POST /upload/ — Subir CSV/XLSX

**Request:** multipart/form-data con archivo
**Response:**
```json
{
  "file_id": "uuid",
  "columns": ["First Name", "Last Name", "Domain", ...],
  "rows_count": 100,
  "preview": [ { "First Name": "Juan", ... }, ... ]   // primeras 5 filas
}
```

### POST /upload/{file_id}/process — Procesar archivo subido

**Request:**
```json
{
  "column_mapping": {
    "first_name": "First Name",
    "last_name": "Last Name",
    "domain": "Domain",
    "full_name": "Full Name",
    "email": null
  },
  "max_tier": 2,
  "mode": "find"
}
```

**Response:** BatchJobResponse (igual que /find/batch)

### GET /upload/{file_id}/download — Descargar CSV de resultados

Retorna CSV con columnas originales + found_email, status, confidence, method, cost_usd, pattern.

### GET /stats/ — Metricas

```json
{
  "total_searches": 100,
  "total_valid_found": 15,
  "success_rate": 0.15,
  "methods_breakdown": { "emaillistverify": 15 },
  "total_cost_usd": 0.099,
  "avg_cost_per_email": 0.00099,
  "domains_in_cache": 93,
  "patterns_learned": 8,
  "catch_all_domains": 17
}
```

### GET /health — Health check

```json
{ "status": "ok" }
```

---

## 11. Servicios

### 11.1 Job Manager

Gestiona batch jobs asincrono.

**`create_and_run_batch_job(contacts, max_tier, webhook_url, mode)`**
1. Generar UUID como job_id
2. Insertar en `batch_jobs` con status="queued"
3. Ejecutar procesamiento en background
4. Retornar job_id inmediatamente

**Background processing:**
1. Actualizar status a "processing"
2. Para cada contacto:
   - Si mode="find": llamar `find_email(contact)`
   - Si mode="verify": llamar `verify_single_email(contact.email, max_tier)`
   - Construir BatchResultItem
   - Cada 10 contactos: actualizar DB con progreso
3. Al terminar: status="completed"
4. Si webhook_url: POST resultados como JSON
5. Si error: status="failed", guardar resultados parciales

**Webhook payload:**
```json
{
  "job_id": "uuid",
  "status": "completed",
  "total": 100,
  "results": [ ... ]
}
```

### 11.2 File Processor

**`process_upload(file)`**
1. Generar UUID como file_id
2. Guardar archivo en `uploads/{file_id}_{original_name}`
3. Leer con parser CSV/XLSX
4. Extraer columns, row_count, preview (5 filas)
5. Guardar metadata en `uploaded_files`
6. Retornar UploadResponse

**`build_contacts_from_file(file_id, column_mapping, mode)`**
1. Leer metadata de DB
2. Leer archivo con parser
3. Para cada fila: mapear columnas a FindRequest
   - Si full_name mapeado pero no first/last: ok (pipeline lo parsea)
   - Si falta domain (mode=find): saltar fila
   - Si falta email (mode=verify): saltar fila
4. Retornar lista de FindRequest

**`generate_results_csv(file_id, results)`**
1. Leer archivo original
2. Agregar columnas: found_email, status, confidence, method, cost_usd, pattern
3. Guardar como `uploads/{file_id}_results.csv`

---

## 12. UI Web

Interfaz minima con HTML server-rendered + HTMX para interactividad sin SPA.

### Paginas:
- **`/`** — Busqueda individual (form con first_name, last_name, domain, full_name, max_tier)
- **`/batch`** — Upload CSV/XLSX con drag-drop, column mapping, progress bar
- **`/stats-page`** — Dashboard de metricas

### Fragmentos HTMX (retornan HTML parcial):
- **`POST /ui/find`** — Ejecuta pipeline, retorna card con resultado
- **`GET /ui/stats`** — Retorna cards de metricas
- **`GET /ui/jobs/{id}/progress`** — Retorna progress bar + tabla de resultados

### Stack UI:
- TailwindCSS via CDN
- HTMX via CDN
- JavaScript minimo (solo para form→JSON y file upload)
- Templates server-side (Jinja2 en Python, cualquier template engine en TS)

---

## 13. Datos Estaticos

### data/disposable_domains.txt
~500 dominios de email temporales. Uno por linea. Ejemplos:
```
mailinator.com
guerrillamail.com
tempmail.com
yopmail.com
throwaway.email
sharklasers.com
...
```

### data/free_providers.txt
~40 proveedores de email gratuito:
```
gmail.com
yahoo.com
hotmail.com
outlook.com
icloud.com
protonmail.com
...
```

### data/role_accounts.txt
~40 cuentas de rol:
```
info
admin
support
contact
sales
hello
help
office
...
```

---

## 14. Notas de Implementacion

### Rendimiento
- **Concurrencia:** Procesar multiples contactos en paralelo (5 concurrentes es buen default)
- **Cache DNS:** domain_intel se cachea 7 dias, evita miles de DNS lookups repetidos
- **Cache verificacion:** 30 dias, evita re-verificar emails conocidos
- **Pattern learning:** Despues de encontrar 1 email en un dominio, las siguientes busquedas en ese dominio prueban el patron conocido PRIMERO, reduciendo a 1 API call

### Costos
- DNS/domain checks: gratis (local)
- Disposable/free/role checks: gratis (listas locales)
- EmailListVerify: $0.0004/email
- DeBounce: $0.0015/email
- Bouncer: $0.003/email
- NeverBounce: $0.008/email
- Costo tipico por lead: $0.001-0.005 (dependiendo de cuantas permutaciones se prueban)

### Escalabilidad
- SQLite para empezar → PostgreSQL si superas ~50K registros
- Background jobs inline → Job queue (BullMQ, etc) para multiples workers
- Agregar mas providers editando solo la cascada

### Equivalencias TypeScript

| Python | TypeScript |
|---|---|
| FastAPI | Hono / Fastify / Express |
| Pydantic | Zod |
| aiosqlite | better-sqlite3 / drizzle-orm |
| httpx | fetch / axios |
| dnspython | dns.promises (Node built-in) |
| pandas | papaparse + xlsx |
| Jinja2 + HTMX | Cualquier template engine + HTMX |
| asyncio.gather | Promise.all |
| unicodedata (NFD) | string.normalize("NFD") |

### Errores comunes a evitar
1. No crashear nunca en el pipeline — siempre retornar un VerificationResult
2. No cobrar costo cuando hay error de API (error_credit, timeout, etc)
3. Deduplicar permutaciones antes de verificar (no pagar 2x por el mismo email)
4. Respetar max_tier — no llamar APIs de tier superior al solicitado
5. Los nombres LATAM usan el primer apellido, no el ultimo — siempre re-parsear full_name
