# Identity Cache & Enrichment API

Service to ingest, normalize, and enrich identity data (Profiles & Companies). It allows upserting records based on normalized keys and merging data into a unified record. Includes an **Email Finder** module for discovering and verifying professional email addresses.

## Features
- **Profiles**:
  - Normalization: Email, LinkedIn (Slug & Full URL), Phone.
  - Resolution: Email > LinkedIn URL > LinkedIn Slug > Phone.
- **Companies**:
  - Normalization: Domain (trim, lowercase, remove www/protocol), LinkedIn.
  - Resolution: Domain > LinkedIn.
- **Email Finder**:
  - Given a name + domain, generates email permutations (15 patterns, LATAM-aware).
  - SERP-based pattern discovery: searches Google for `"@domain.com"` to find real emails and identify the domain's pattern before brute-forcing.
  - Cross-references multiple SERP emails to resolve ambiguous patterns (flast vs lastf, etc.).
  - Multi-tier API verification cascade (EmailListVerify, DeBounce).
  - Smart catch-all handling: uses SERP patterns + Debounce cross-validation instead of blind guessing.
  - Domain intelligence: MX lookup, provider detection, disposable/free checks.
  - Pattern learning: remembers verified patterns per domain for faster future lookups.
  - Verification caching (30 days) and domain intel caching (7 days).
  - Parallel verification for speed (batches of 5 concurrent API calls).
- **Tech Detector**:
  - Given a URL, fetches its HTML and detects web technologies (CMS, ecommerce, analytics, tag managers, marketing tools, advertising pixels, payment integrations, CDN, SEO plugins, and privacy tools).
- **Data Merging**: Merges JSON data safely.
- **ORM**: Builds on **Prisma** + **Supabase** (PostgreSQL).

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Environment Variables**:
   Copy `.env.example` to `.env` and add your keys:
   ```bash
   cp .env.example .env
   ```
   
   Required variables:
   - `PORT`: Server port (default 3000)
   - `API_KEY`: Bearer token for authentication
   - `DATABASE_URL`: Connection Pool URL (Transaction Mode, Port 6543)
   - `DIRECT_URL`: Direct Connection URL (Session Mode, Port 5432)
   - `SERPER_API_KEY`: SERP pattern discovery (google.serper.dev)
   - `EMAILLISTVERIFY_API_KEY`: Tier 1 verification provider
   - `DEBOUNCE_API_KEY`: Tier 2 verification provider

3. **Database Setup**:
   Push the schema to your database:
   ```bash
   npm run prisma:push
   ```

## Usage

**Start Development Server**:
```bash
npm run dev
```

**Production Build**:
```bash
npm run build
npm start
```

**API Endpoints**:

See full documentation at `GET /docs/api` or visit `http://localhost:3000/docs/api` locally.

- **Profiles**
  - `POST /profiles`: Upsert/Enrich a profile.
  - `GET /profiles`: Query by `email`, `linkedin`, or `phone`.

- **Companies**
  - `POST /companies`: Upsert/Enrich a company.
  - `GET /companies`: Query by `domain` or `linkedin`.

- **Email Finder**
  - `POST /find`: Find email by name + domain.
  - `POST /verify`: Verify an existing email address.
  - `GET /stats`: Aggregate metrics for the email finder.

- **Tech Detector**
  - `POST /detect-tech`: Detect web technologies from a URL.

### Example: Find Email

```bash
curl -X POST http://localhost:3000/find \
  -H "Authorization: Bearer your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"first_name": "Juan", "last_name": "Garcia", "domain": "empresa.com"}'
```

### Example: Verify Email

```bash
curl -X POST http://localhost:3000/verify \
  -H "Authorization: Bearer your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"email": "juan@empresa.com"}'
```

### Example: Detect Technologies

```bash
curl -X POST http://localhost:3000/detect-tech \
  -H "Authorization: Bearer your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

**Response:**
```json
{
  "success": true,
  "url": "https://example.com",
  "cms": "WordPress 6.4",
  "ecommerce": "WooCommerce",
  "analytics": ["Google Analytics (GA4)", "Facebook Pixel"],
  "tag_managers": ["Google Tag Manager"],
  "frameworks": [],
  "marketing": ["HubSpot", "Intercom"],
  "advertising": ["Google Ads", "LinkedIn Insight Tag"],
  "payments": ["Stripe"],
  "cdn": ["Cloudflare"],
  "seo": ["Yoast SEO"],
  "privacy": ["OneTrust"],
  "otros": [],
  "resumen": "WordPress 6.4 | WooCommerce | Google Analytics (GA4) | Facebook Pixel | Google Tag Manager | HubSpot | Intercom | Google Ads | LinkedIn Insight Tag | Stripe | Cloudflare | Yoast SEO | OneTrust"
}
```

**Detected categories:**
| Field | Description |
|-------|-------------|
| `cms` | CMS platform (WordPress, Shopify, Wix, Webflow, etc.) |
| `ecommerce` | E-commerce platform (WooCommerce, Shopify, VTEX, Tiendanube) |
| `analytics` | Analytics tools (GA4, Facebook Pixel, Hotjar, Mixpanel, etc.) |
| `tag_managers` | Tag managers (Google Tag Manager) |
| `frameworks` | JS frameworks (empty — no Wappalyzer integration) |
| `marketing` | CRM & marketing tools (HubSpot, Intercom, Mailchimp, etc.) |
| `advertising` | Ad pixels (Google Ads, LinkedIn, TikTok, Pinterest, etc.) |
| `payments` | Payment integrations (Stripe, PayPal, MercadoPago) |
| `cdn` | CDN providers (Cloudflare, jsDelivr, unpkg) |
| `seo` | SEO plugins (Yoast SEO, RankMath) |
| `privacy` | Consent tools (OneTrust, CookieBot) |
| `resumen` | Human-readable summary of detected technologies |

## Email Finder — Cost per Lookup

Each lookup runs through a pipeline with up to 3 paid services. Actual cost depends on how quickly a valid email is found.

| Service | Cost per call | When it runs |
|---|---|---|
| Serper (SERP) | $0.001 | Always (1 search per domain) |
| EmailListVerify (Tier 1) | $0.0004 / email | Each permutation tested |
| Debounce (Tier 2) | $0.0015 / email | Cascade fallback or catch-all cross-validation |

**Estimated cost by scenario:**

| Scenario | Serper | ELV | Debounce | Total |
|---|---|---|---|---|
| Cache hit | — | — | — | **$0.000** |
| SERP direct match (1 ELV call) | $0.001 | $0.0004 | — | **$0.0014** |
| Found in 1st batch (5 perms) | $0.001 | $0.002 | — | **$0.003** |
| Catch-all domain (1 batch + Debounce) | $0.001 | $0.002 | $0.0015 | **$0.0045** |
| 2 batches, Tier 1 only | $0.001 | $0.004 | — | **$0.005** |
| Worst case (15 perms, both tiers) | $0.001 | $0.006 | $0.0225 | **$0.0295** |

**Typical cost: ~$0.003 per email** (SERP patterns prioritize the right permutation early).

## Pending / Roadmap
- `POST /find/batch` — Batch email finding (array of contacts, background processing).
- `POST /verify/batch` — Batch email verification.
- Tier 3 verification provider (NeverBounce).

## Testing Normalization
Run the verification scripts:
```bash
npx ts-node src/verify_normalization.ts # Profiles
npx ts-node src/verify_companies.ts     # Companies
```
