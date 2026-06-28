# Client Records & GDPR Module — Design

**Parent spec:** `2026-06-28-greek-dietitian-saas-design.md` (§6.2 Client records, §6.8 GDPR cross-cutting)
**Status:** approved in brainstorming, ready for implementation plan
**Date:** 2026-06-28

## 1. Summary

First v1 domain module on top of the shipped foundation (multi-tenancy + auth +
RLS Path B). Manages the practice's core regulated asset: client health records.
Ships with GDPR data-subject rights (access/export, erasure, rectification) as
**operative services**, not stubs — done via a concrete service plus a
schema-coverage test, not a plugin registry (premature abstraction at n=1).

This module is the **dependency root**: every later domain table
(meal plans, measurements, appointments, invoices) references a client.

## 2. Goals / Non-goals

### Goals
- Client CRUD (demographics, contact, clinical fields), tenant-isolated via RLS.
- **Lawful basis recorded as a fact** for clinical processing — GDPR Art 9(2)(h)
  (provision of healthcare) + Greek Law 4624/2019. Not a revocable toggle.
- **Withdrawable consents** for *optional* processing, separate from lawful basis.
- **Append-only audit log** of access and mutation of client records.
- **Operative GDPR rights now:** per-client data export + erasure/anonymization
  for the data that exists today.
- A **coverage test** that fails when any future `client_id` table is not wired
  into export + erasure.

### Non-goals (this module)
- Invoice/tax-retention erasure semantics — deferred to billing module (depends
  on myDATA spike outcome; see §6). A documented policy slot is left for it.
- Enforcement of portal-access / marketing / third-party-sharing consents — those
  features don't exist in v1; the consent is *recorded* now, *enforced* when the
  feature ships.
- Client-facing UI / portal (v2).
- Structured medical coding (ICD etc.) — freeform v1.

## 3. Lawful basis vs consent (the legal distinction)

- **Clinical data** (medical history, allergies, goals, notes) is processed under
  **Art 9(2)(h) healthcare provision**. Recorded on the client row as a fact
  (`lawful_basis`). "Withdrawing" it = ending the care relationship, not a data
  operation. It is NOT a consent toggle.
- **Consents** are granular, timestamped, withdrawable grants for *optional*
  processing only. Modeling clinical processing as consent would be legally wrong.

## 4. Data model (3 new tables)

All tables: `tenant_id uuid not null`, own RLS policy (the `notes` pattern from
foundation), `enableRLS()` + hand-edited migration adds `FORCE ROW LEVEL
SECURITY`. All request-path access goes through `withUser(verifiedUserId, …)`.

### `clients`
```
id            uuid pk default random
tenant_id     uuid not null
first_name    text not null
last_name     text not null
dob           date
sex           text                 -- free string, nullable (not an enum v1)
email         text
phone         text
address       text
afm           text                 -- nullable; needed for B2B invoices later
medical_history text
allergies     text[] default '{}'  -- array: food DB will cross-reference
goals         text
notes         text                 -- clinical notes (special-category)
lawful_basis  text not null default 'art_9_2_h_healthcare'
created_at    timestamptz not null default now()
updated_at    timestamptz not null default now()
deleted_at    timestamptz          -- soft delete; null = active
```
RLS: `tenant_id = (select tenant_id from tenant_members where user_id =
current_setting('app.user_id', true) limit 1)` for using + withCheck.

### `client_consents`
```
id           uuid pk default random
tenant_id    uuid not null
client_id    uuid not null references clients(id) on delete cascade
scope        text not null         -- 'email_comms'|'marketing'|'third_party_sharing'|'portal_access'
granted_at   timestamptz not null default now()
withdrawn_at timestamptz           -- null = active grant
text_version text not null         -- which consent wording the client agreed to
```
Withdraw = set `withdrawn_at` (never hard-delete — audit trail). Same RLS policy.
A client may have multiple rows per scope over time (re-granting after withdrawal).
"Active consent for scope X" = latest row for (client_id, scope) with
`withdrawn_at is null`.

### `audit_log`
```
id            uuid pk default random
tenant_id     uuid not null
actor_user_id text not null        -- the verified user from session
action        text not null        -- 'view'|'create'|'update'|'delete'|'export'|'erase'
entity        text not null        -- e.g. 'client','consent'
entity_id     uuid
at            timestamptz not null default now()
metadata      jsonb                -- optional structured detail; MUST be PII-free
```
**Append-only:** `authenticated_backend` is granted INSERT + SELECT only on this
table (no UPDATE/DELETE grant). Erasure anonymizes via the owner/migration path,
not the request path. Same tenant-isolation RLS policy for SELECT.

## 5. Services (`lib/` or `db/services/`, following foundation layout)

- **client-service** — create / get / list / update / softDelete. Every method
  runs inside `withUser()`. Mutations + reads of a single client write an audit
  row (`view` on read-one, `create`/`update`/`delete` on mutation). List views are
  audited as a single `view` with `entity='client'`, `entity_id=null`.
- **consent-service** — `grant(clientId, scope, textVersion)`,
  `withdraw(clientId, scope)`, `activeConsents(clientId)`. Writes audit rows.
- **audit-service** — single `record({action, entity, entityId, metadata})`
  writer. The ONLY writer of `audit_log`. Asserts metadata carries no PII via the
  shared `lib/pii-denylist` (reuse foundation's denylist).
- **gdpr-service**
  - `exportClient(clientId)` → structured JSON of every row referencing the
    client across all covered tables. Writes an `export` audit row.
  - `eraseClient(clientId)` → **per-table erasure policy**, explicit per table:
    - `clients` → hard delete the row.
    - `client_consents` → hard delete (cascade).
    - `audit_log` → **anonymize, not delete**: null/pseudonymize any client
      reference, retain the rows (audit is itself a legal obligation). Runs via a
      privileged path (owner client), since request path has no UPDATE grant.
    - Writes a final `erase` audit row (anonymized actor=system, no client PII).
  - Invoice / other tax-retained tables → **documented policy slot**, filled by
    the billing module after the myDATA spike resolves retention rules.

## 6. The GDPR coverage forcing-test

A test introspects the live schema (information_schema / Drizzle metadata):
enumerate every table with a `client_id` column. Assert each is referenced by
**both** `exportClient` and `eraseClient`, and that erasure classifies it as
delete-or-anonymize (no silent omission). A new domain module that adds a
`client_id` table without wiring GDPR coverage turns this test **red**. This is
the forcing function — replaces a plugin registry with a cheaper guarantee.

## 7. RLS & isolation testing

- Each new table: own `*_tenant_isolation` policy, `FORCE`d, fail-closed.
- Integration tests (live Neon, the foundation harness) prove per table:
  allow-own, deny-cross-read, deny-cross-insert (withCheck), fail-closed on empty
  user. Mirror `tests/integration/rls-isolation.test.ts`.
- `audit_log` test additionally proves request-path role **cannot** UPDATE/DELETE
  (append-only enforced at the grant level).

## 8. Testing approach

- **TDD** on service logic: consent grant→withdraw→re-grant state machine;
  `activeConsents` latest-row semantics; erasure per-table policy (delete vs
  anonymize); audit append-only; export completeness.
- **Unit**: Vitest. **Integration**: per-table RLS + append-only + coverage test.
- Privacy regression: audit `metadata` rejects denylisted keys.

## 9. Error handling

- All cross-tenant access fails closed (RLS default deny).
- Erasure is transactional where possible; the `audit_log` anonymization step runs
  on the owner connection and is logged. Partial-erasure must not leave clinical
  rows behind silently — on failure, surface and do not mark the client erased.
- Export of a non-existent / cross-tenant client returns not-found (RLS denies).

## 10. Build order (for the plan)

1. `clients` table + RLS + migration (FORCE) + isolation test.
2. client-service CRUD + soft-delete (no audit yet) + tests.
3. `audit_log` table + RLS + append-only grant + audit-service + wire into
   client-service.
4. `client_consents` table + RLS + consent-service (grant/withdraw/active) + tests.
5. gdpr-service export + erasure (per-table policy) + tests.
6. Coverage forcing-test.

## 11. Open questions

- Exact Greek consent wording (`text_version`) — provided by the user's
  practicing dietitian before go-live; schema stores it, copy is not blocking.
- Whether `sex` needs to be an enum for later clinical calcs (BMR formulas in
  anthropometrics module) — deferred; free string now, revisit when that module
  lands.
