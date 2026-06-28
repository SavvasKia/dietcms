# Greek Dietitian SaaS — v1 Design

**Date:** 2026-06-28
**Status:** Approved design, pending implementation plan
**Working name:** dietcms (to be renamed)

## 1. Summary

A multi-tenant SaaS practice platform for dietitians/nutritionists, targeting the
Greek market first. v1 is an all-in-one practice-management + nutrition tool for
the dietitian (no client-facing portal yet). The core wedge against the incumbent
Greek competitor **Evexis** is twofold:

1. **myDATA (ΑΑΔΕ) e-invoicing** — Evexis does not offer it; a national mandate
   forces every Greek business onto it by **1 October 2026**.
2. **A genuine Greek food/nutrient database** — Evexis ships a translated USDA
   table; we build a Greek-first database.

## 2. Background & research basis

Verified via multi-source research (2026-06-28):

- The all-in-one nutrition-software category consists of six feature groups:
  practice management, client engagement, nutrition tools (meal planning +
  nutrient DB + food analysis — the category differentiator), clinical
  documentation, telehealth, and data security. Corroborated across Practice
  Better, Nutrium, ProMealPlan, Healthie, Carepatron.
- **myDATA** is the AADE platform for e-invoice/e-book transmission. Mandatory B2B
  e-invoicing phases in during 2026: large firms (>€1M 2023 revenue) from
  **2 Mar 2026**, all other businesses from **1 Oct 2026**. Each invoice must be
  transmitted to obtain a 14-digit **MARK** (Μοναδικός Αριθμός Καταχώρησης) or it
  is not legally valid.
- Health/patient data is **special-category data** under GDPR + Greek **Law
  4624/2019**. Processing is lawful for medical purposes (preventive medicine,
  diagnosis, provision of health benefits). Requires explicit, specific consent
  and enhanced technical controls.
- Credible Greek food composition sources exist: Trichopoulou & Georga (2004)
  composition tables, Hellenic Health Foundation tables, HelTH branded-food DB
  (4,002 products, research/policy — commercial licensing **unverified**),
  Nutrinet (commercial). v1 will **build its own DB from public sources**.
- **Evexis** (evexis.eu): Greek, cloud, cheap (~€123/yr). Practice management +
  USDA-translated nutrition. **No myDATA, no EOPYY**, no native Greek food DB.

### Decisions locked during brainstorming
- **Product type:** all-in-one platform, phased — v1 = practice management for the
  dietitian. Client portal and content CMS are later phases.
- **Business model:** commercial multi-tenant SaaS sold to many Greek dietitians.
- **Stack:** Next.js (App Router) + React + Tailwind, deployed on **Vercel**.
- **Food DB:** build own from public sources (Trichopoulou/HHF/USDA, Greek-first).
- **Domain validation:** a practicing Greek dietitian is available to validate
  workflows, meal-plan structure, and charting needs.
- **v1 scope:** single v1 release including myDATA billing.
- **Architecture:** locked — multi-tenant + Postgres RLS + Drizzle ORM, EU-region
  hosting.
- **Database & auth:** **Neon** (serverless Postgres, EU region) + **Neon Auth**
  (Stack Auth) for authentication; RLS policies key off the auth JWT.
- **Observability:** **Sentry** (errors) + **PostHog** (product analytics, EU
  Cloud) — both configured to never receive special-category/health data.
- **Testing:** **Playwright** (E2E) + **Vitest** + React Testing Library (unit).

## 3. Goals / Non-goals

### Goals (v1)
- A Greek dietitian can sign up, manage clients, build meal plans from a
  Greek-first food DB, track anthropometrics, schedule appointments, and issue
  myDATA-compliant invoices.
- GDPR special-category compliance is built in, not bolted on.
- Tenant data is isolated at the database level (RLS), not only in app code.

### Non-goals (v1)
- Client-facing portal / mobile app (v2).
- Content/website CMS — articles, recipes, SEO (v3).
- Telehealth/video (v2+).
- EOPYY / insurance reimbursement (deferred; scope unverified — see open
  questions).
- Marketing automations, multi-language UI beyond Greek + English.

## 4. Users & roles (v1)
- **Dietitian (tenant owner)** — full access to their practice's data.
- **Practice staff (optional, v1.x)** — secretary/assistant with scoped access.
  May defer to post-v1; schema should not preclude it.
- No patient/client login in v1 (clients are records, not users).

## 5. Architecture

### 5.1 Multi-tenancy
- **Shared database, shared schema, `tenant_id` on every tenant-owned row.**
- **Postgres Row-Level Security (RLS)** enforces isolation: every query runs under
  a session `tenant_id`; policies restrict rows to the current tenant. App bugs
  cannot leak cross-tenant data.
- Tenant context comes from the **Neon Auth JWT**: the authenticated user's
  claims (`user_id` → tenant mapping) are available to RLS policies via Neon's
  authenticated DB connection, so isolation is enforced from the verified token
  rather than app-set session variables. A user→tenant membership table maps
  identities to their tenant.

### 5.2 Stack
- **Next.js App Router** — server components + server actions / route handlers.
- **React + Tailwind** — UI.
- **Vercel** — hosting; serverless functions **pinned to an EU region** (GDPR data
  residency — US region is non-compliant for health data).
- **Neon** — serverless Postgres, **EU region**. Encryption at rest; TLS in
  transit.
- **Drizzle ORM** — chosen over Prisma for explicit SQL and RLS-friendliness;
  works directly against Neon.
- **Neon Auth (Stack Auth)** — dietitian authentication. Manages the user
  identity store and issues JWTs whose claims (`user_id`, tenant) drive Postgres
  RLS policies. Replaces Auth.js.

### 5.4 Third-party processors & data-protection config
All external services are GDPR **data processors**; each needs a signed DPA and
must be configured to never receive special-category (health) data:
- **Sentry** — `beforeSend` scrubs PII; request bodies/headers disabled; data
  masked. EU data region. No client medical data in error context.
- **PostHog** — **EU Cloud** (`eu.posthog.com`). Autocapture input masking ON
  (mask all form fields); only non-identifying product events; never send
  client/patient attributes.
- **Neon / Vercel** — EU region; DPAs in place.
- **myDATA provider** — processes invoice data (incl. client ΑΦΜ/name); covered by
  the medical-billing legal basis and provider DPA.

### 5.5 Observability & testing
- **Sentry** for error tracking, **PostHog** for product analytics (both scoped
  per §5.4).
- **Vitest + React Testing Library** for unit/component tests.
- **Playwright** for end-to-end flows (signup → client → meal plan → invoice).

### 5.3 Module boundaries
Each module is a bounded unit with its own schema tables, service layer, and UI
routes. Modules communicate through service functions, not by reaching into each
other's tables.

1. **Tenant & Auth** — accounts, practice profile, subscription stub, session →
   tenant context, RLS bootstrap.
2. **Client records** — client CRUD, GDPR consent capture, audit log.
3. **Food database** — food/nutrient schema + import pipeline.
4. **Meal-plan builder** — plans composed from foods, automatic nutrient totals.
5. **Anthropometrics & progress** — measurements over time + charts.
6. **Scheduling** — appointments/calendar.
7. **Billing & myDATA** — invoices, transmission to AADE, MARK storage.
8. **GDPR cross-cutting** — consent, audit log, data export/erasure, retention.

## 6. Modules — features and why

### 6.1 Tenant & Auth
- Dietitian signup/login via **Neon Auth**; on first login create a `tenant` and
  a `tenant_members` row. Practice profile (name, ΑΦΜ/VAT, address — needed for
  invoices), subscription state (stub; real billing-for-subscription later).
- **Why:** the multi-tenant boundary and the source of every row's `tenant_id`;
  the JWT that drives RLS originates here.

### 6.2 Client records
- Demographics, contact, medical history, allergies, goals, notes/charting.
- **GDPR consent capture**: explicit, specific, timestamped, withdrawable;
  recorded as first-class data with legal basis (medical purpose).
- **Audit log**: who accessed/changed which client record and when.
- **Why:** health records are the practice's core asset and the regulated
  special-category data; consent + audit are legal requirements, not features.

### 6.3 Food database
- Schema: foods, nutrients (per 100g + portion units), categories, source
  attribution, Greek + English names, branded-product flag.
- **Import pipeline**: ingest public sources (Trichopoulou 2004, HHF, USDA for
  gaps), normalize units/nutrients, deduplicate, tag language/source.
- Dietitian can add/edit custom foods and Greek branded products.
- **Why:** the nutrition differentiator. A real Greek DB is the reason to choose
  this over Evexis. Build-your-own avoids unverified HelTH/HHF commercial
  licensing.

### 6.4 Meal-plan builder
- Compose a plan (days → meals → food items with quantities); live totals for
  energy + macros (and key micros where data exists); targets vs actual.
- Reusable templates; export/print/PDF for the client.
- **Why:** the dietitian's primary daily deliverable; ties food DB → client.

### 6.5 Anthropometrics & progress
- Record weight, body composition, circumferences, BMI, etc., over time.
- Progress charts per client.
- **Why:** demonstrates outcomes; drives client adherence and retention; standard
  clinical tooling.

### 6.6 Scheduling
- Appointment calendar, per-client booking, status, reminders (email v1).
- **Why:** table-stakes practice management; every competitor has it.

### 6.7 Billing & myDATA  ← the moat + the deadline
- Issue invoices (ΑΦΜ, line items, VAT) for services.
- **Transmit to AADE myDATA**, store the returned **MARK**; surface validation
  status. Recommended initial path: a **certified e-invoicing provider** rather
  than raw AADE API (faster, less compliance surface) — to be confirmed by a
  spike.
- **Why:** legally mandatory for Greek businesses by **1 Oct 2026**, and the
  single biggest gap in Evexis. Primary acquisition hook.

### 6.8 GDPR cross-cutting
- Consent lifecycle, audit logging, **data export** and **erasure** per client,
  retention policy, EU data residency, encryption.
- **Why:** special-category data carries the heaviest GDPR obligations; must be
  designed in from the first table.

## 7. Data model sketch (initial)

- `tenants(id, name, afm, address, subscription_state, created_at)`
- Identity/users are managed by **Neon Auth (Stack Auth)**; we keep a
  `tenant_members(user_id, tenant_id, role)` table mapping auth identities to a
  tenant and role (no password storage on our side).
- `clients(id, tenant_id, name, dob, contact, medical_history, allergies, goals, ...)`
- `consents(id, tenant_id, client_id, basis, scope, granted_at, withdrawn_at)`
- `audit_log(id, tenant_id, actor_user_id, action, entity, entity_id, at)`
- `foods(id, tenant_id NULLABLE, name_el, name_en, category, source, is_branded)`
  — global rows (`tenant_id` null) vs tenant-custom foods.
- `food_nutrients(food_id, nutrient, amount_per_100g, unit)`
- `meal_plans(id, tenant_id, client_id, title, created_at)`
- `meal_plan_items(plan_id, day, meal, food_id, quantity, unit)`
- `measurements(id, tenant_id, client_id, type, value, unit, measured_at)`
- `appointments(id, tenant_id, client_id, starts_at, ends_at, status, notes)`
- `invoices(id, tenant_id, client_id, total, vat, status, mark, mydata_payload, issued_at)`

RLS policy on every table with `tenant_id`. Global food rows are readable by all
tenants, writable by none (admin-only seed).

## 8. Error handling & reliability
- myDATA transmission is an **external integration** → must be resilient:
  queue/retry, store request+response, never lose an invoice if AADE is down,
  surface clear status (draft / transmitted / failed / validated-with-MARK).
- Food import pipeline is idempotent and re-runnable; bad rows are quarantined,
  not silently dropped.
- All cross-tenant access attempts fail closed (RLS default deny).

## 9. Testing approach
- **Vitest + React Testing Library** — unit/component tests; **TDD** for service
  layers (meal-plan nutrient math, invoice/VAT calc, consent/audit logic).
- **Playwright** — E2E flows (signup → client → meal plan → myDATA invoice).
- **RLS isolation tests**: assert tenant A cannot read/write tenant B's rows,
  exercised at the DB layer (two JWTs, same query, opposite results).
- **myDATA integration tests** against a sandbox/mock of the provider/AADE.
- **Food import tests**: unit normalization, dedup, language tagging.
- **Privacy regression test**: assert no client/health fields reach Sentry or
  PostHog payloads.

## 10. v1 build order (mitigates the Oct deadline risk)
Front-load the moat so myDATA is not rushed last:
1. Tenant & Auth + RLS foundation
2. Client records + GDPR consent/audit (regulated core)
3. Food DB schema + import pipeline (long-lead data work — start early)
4. Billing & myDATA spike + integration (deadline-critical — start in parallel
   once tenancy exists, do not leave for the end)
5. Meal-plan builder
6. Anthropometrics & progress
7. Scheduling

## 11. Risks & open questions
- **Food DB effort** — digitizing public sources is real work; needs the
  dietitian + a data plan. Differentiation depends on it.
- **myDATA integration path** — direct AADE API vs certified provider:
  cost/effort tradeoff. **Needs a research spike before billing is built.**
- **GDPR technical controls** — concrete HDPA expectations (encryption,
  retention, DPIA, professional secrecy) need confirmation for a health SaaS.
- **EOPYY reimbursement** — whether/how EOPYY reimburses dietitians is
  **unconfirmed**; deferred from v1 until scoped.
- **Deadline** — single-v1-including-myDATA risks missing 1 Oct 2026; build order
  above is the mitigation. Re-evaluate splitting if slipping.
- **Food DB commercial licensing** — HelTH/HHF "not publicly available" for
  commercial use; avoided in v1 by building from public-domain/citable sources,
  but legal review of source reuse is advised.
- **Third-party data leakage** — Sentry/PostHog can silently capture health data
  via autocapture/error context. Mitigated by §5.4 config + the privacy
  regression test, but requires ongoing vigilance on every new form/event.
- **Neon Auth + RLS wiring** — driving RLS from the auth JWT over Vercel
  serverless (authenticated connection per request, pooling, cold starts) is the
  riskiest infra integration; validate with a spike before building on it.
- **EU region discipline** — every service (Neon, Vercel functions, Sentry,
  PostHog) must be EU-pinned; a single US-region default breaks GDPR residency.

## 12. Success criteria (v1)
- A Greek dietitian onboards and runs a real client end-to-end: record →
  meal plan from Greek foods → track progress → issue a myDATA-validated invoice
  (MARK returned).
- Demonstrable tenant isolation (RLS tests green).
- GDPR: consent captured, audit log populated, client data exportable and
  erasable.
