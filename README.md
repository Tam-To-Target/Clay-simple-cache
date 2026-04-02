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
  - Multi-tier API verification cascade (EmailListVerify, DeBounce).
  - Domain intelligence: MX lookup, provider detection, disposable/free checks.
  - Pattern learning: remembers verified patterns per domain for faster future lookups.
  - Verification caching (30 days) and domain intel caching (7 days).
  - Parallel verification for speed (batches of 5 concurrent API calls).
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
