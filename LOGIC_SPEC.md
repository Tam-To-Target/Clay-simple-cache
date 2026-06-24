# Email Cache — Especificacion de Logica

Documento de referencia para reimplementar el modulo de verificacion y cache de emails en cualquier lenguaje (TypeScript, Go, etc). Contiene la logica de negocio, estructuras de datos, APIs externas y contratos de endpoints.

---

## Tabla de Contenidos

1. [Vision General](#1-vision-general)
2. [Tipos y Enums](#2-tipos-y-enums)
3. [Configuracion](#3-configuracion)
4. [Base de Datos](#4-base-de-datos)
5. [Modulo: Domain Intelligence](#5-modulo-domain-intelligence)
6. [Modulo: Providers (APIs de Verificacion)](#6-modulo-providers)
7. [Modulo: Pipeline (Verificacion)](#7-modulo-pipeline)
8. [API Endpoints](#8-api-endpoints)
9. [Datos Estaticos](#9-datos-estaticos)

---

## 1. Vision General

**Input:** Un email existente
**Output:** Estado de verificacion + nivel de confianza

### Flujo de verificacion (verify_single_email)

```
Input: { email, max_tier }
  │
  ▼
1. Validar sintaxis (contiene @) → si no, "invalid"
2. Revisar cache de verificaciones (verification_cache)
   - Si existe y no expiro → retornar resultado cacheado (costo 0)
3. Analizar dominio (MX, disposable)
4. Early exit si: no_mx, disposable
5. Cascada de APIs (Tier 1 → Tier 2)
   - valid / invalid / catch_all → conclusivo, detener
   - risky → retornar
6. Cachear resultado (si no es "unknown")
7. Retornar
```

El sistema **no** genera ni adivina direcciones de email — solo verifica emails provistos y cachea el resultado.

---

## 2. Tipos y Enums

### EmailStatus (string enum)

```
valid         // Email valido
invalid       // Email invalido
catch_all     // Dominio acepta todo (no se puede confirmar el buzon)
unknown       // No concluyente
risky          // Riesgoso (full inbox, etc)
disposable    // Dominio de email temporal
no_mx         // Dominio sin registros MX
role_account  // Cuenta de rol (info@, sales@, etc)
```

### VerificationMethod (string enum)

```
local_syntax
local_dns
emaillistverify  // Tier 1
debounce         // Tier 2
bouncer
neverbounce      // Tier 3 (no implementado)
```

### ProviderType (string enum)

```
google_workspace
office365
yahoo
other
```

### DomainInfo

```
domain: string
has_mx: boolean
mx_records: string[]
provider: ProviderType
is_catch_all: boolean
is_disposable: boolean
is_free_provider: boolean
smtp_verifiable: boolean
```

### VerificationResult

```
email: string | null
status: EmailStatus
confidence: number          // 0.0 - 1.0
method: VerificationMethod | null
domain_info: DomainInfo | null
cost_usd: number
duration_ms: number
```

### CONCLUSIVE_STATUSES

Estados que detienen la cascada: `valid`, `invalid`, `catch_all`.

---

## 3. Configuracion

```
emaillistverify_api_key: string   // Tier 1
debounce_api_key: string          // Tier 2
serper_api_key: string            // usado por LinkedIn finder, no por la verificacion

domain_cache_ttl: number          // default: 604800 (7 dias)
verification_cache_ttl: number    // default: 2592000 (30 dias)
```

---

## 4. Base de Datos

### verification_cache

Cachea resultados de verificacion de emails individuales.

```sql
CREATE TABLE verification_cache (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  status      TEXT NOT NULL,
  confidence  FLOAT DEFAULT 0.0,
  method      TEXT,
  verified_at TIMESTAMPTZ DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_verification_cache_email ON verification_cache(email);
```

Lectura: solo se devuelve si `expires_at > now()`.
Escritura: upsert por `email`, con `expires_at = now() + verification_cache_ttl`.

### domain_intel

Cachea la inteligencia de dominio (MX, provider, disposable, free).

```sql
CREATE TABLE domain_intel (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain           TEXT UNIQUE NOT NULL,
  has_mx           BOOLEAN DEFAULT false,
  mx_records       JSONB DEFAULT '[]',
  provider         TEXT DEFAULT 'other',
  is_catch_all     BOOLEAN DEFAULT false,
  is_disposable    BOOLEAN DEFAULT false,
  is_free_provider BOOLEAN DEFAULT false,
  checked_at       TIMESTAMPTZ DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_domain_intel_domain ON domain_intel(domain);
```

---

## 5. Modulo: Domain Intelligence

**Funcion: `analyze_domain(domain) → DomainInfo`**

1. Revisar cache `domain_intel` (si existe y no expiro, retornar).
2. Resolver registros MX del dominio.
3. `has_mx` = hay registros MX.
4. Detectar provider segun los hosts MX:
   - Contiene "google.com" o "googlemail.com" → `google_workspace`
   - Contiene "outlook.com" / "office365" → `office365`
   - Contiene "yahoodns" → `yahoo`
   - En otro caso → `other`
5. `is_disposable` = dominio en lista de disposables.
6. `is_free_provider` = dominio en lista de free providers.
7. Cachear en `domain_intel` con `expires_at = now() + domain_cache_ttl`.
8. Retornar `DomainInfo` (is_catch_all se detecta solo via API).

---

## 6. Modulo: Providers

Interfaz:

```
interface EmailVerificationProvider {
  name: string
  cost_per_email: number   // USD
  method: VerificationMethod
  is_configured(): boolean
  verify(email: string): Promise<VerificationResult>
}
```

### Tier 1 — EmailListVerify ($0.0004/email)

`GET https://apps.emaillistverify.com/api/verifyEmail?secret={key}&email={email}`

Mapa de respuestas (texto plano):

| Respuesta | Status | Confianza |
|---|---|---|
| `ok` | valid | 0.95 |
| `fail` | invalid | 0.95 |
| `ok_for_all` | catch_all | 0.5 |
| `disposable` | disposable | 0.95 |
| `role` | role_account | 0.8 |
| `email_disabled` | invalid | 0.9 |
| `domain_error` | invalid | 0.9 |
| `unknown` | unknown | 0.3 |
| `error_credit` / `error` | unknown | 0.0 (marca credito agotado) |

### Tier 2 — DeBounce ($0.0015/email)

`GET https://api.debounce.io/v1/?api={key}&email={email}`

- `code === "4"` → catch_all (0.5)
- `result === "safe to send"` → valid (0.95)
- `result === "risky"` → risky (0.5)
- `result === "invalid"` → invalid (0.95)
- otro / falta campo `debounce` → unknown (0.3)

Ambos providers usan timeout de 30s y retornan `unknown` (costo 0) ante error de red.

---

## 7. Modulo: Pipeline

### api_cascade(email, max_tier) → VerificationResult

```
TIERS = [[EmailListVerify], [Debounce]]
totalCost = 0
para cada tier (indice + 1 <= max_tier):
  para cada provider configurado del tier:
    result = provider.verify(email)
    totalCost += result.cost_usd
    si result.status en CONCLUSIVE_STATUSES → retornar result (con totalCost)
    si result.status == risky → retornar result (con totalCost)
retornar unknown (con totalCost)
```

### verify_single_email(email, max_tier=2)

Ver el flujo en la seccion 1. `max_tier` se limita a 2 (Tier 3 no implementado).

---

## 8. API Endpoints

Todos requieren `Authorization: Bearer <API_KEY>` excepto `/health` y `/docs/api`.

### POST /verify

Request:
```json
{ "email": "juan@empresa.com", "max_tier": 2 }
```

Response:
```json
{
  "email": "juan@empresa.com",
  "status": "valid",
  "confidence": 0.95,
  "method": "emaillistverify",
  "domain_info": { "...": "..." },
  "cost_usd": 0.0004,
  "duration_ms": 450
}
```

`400` si falta `email`.

### GET /stats

Metricas agregadas del cache de verificacion:

```json
{
  "emails_cached": 1240,
  "valid_cached": 870,
  "catch_all_cached": 95,
  "methods_breakdown": { "emaillistverify": 720, "debounce": 150 },
  "domains_in_cache": 93
}
```

---

## 9. Datos Estaticos

- `data/disposable_domains.txt` — dominios de email temporales.
- `data/free_providers.txt` — proveedores gratuitos (gmail, yahoo, etc).
- `data/role_accounts.txt` — prefijos de cuentas de rol (info, sales, etc).
