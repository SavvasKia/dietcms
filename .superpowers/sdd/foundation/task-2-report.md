# Task 2 Report: Neon + Drizzle Wiring

## What Was Built

- `db/schema.ts` — Drizzle schema defining `tenants` (uuid pk, name, afm, address, subscription_state, created_at) and `tenantMembers` (composite pk: user_id + tenant_id, FK → tenants.id with cascade, role).
- `db/client.ts` — Drizzle client using `drizzle-orm/neon-serverless` Pool bound to `DATABASE_URL`.
- `drizzle.config.ts` — Drizzle Kit config loading `.env.local` explicitly via `config({ path: '.env.local' })` (not `import 'dotenv/config'`, which only reads `.env`).
- `tests/unit/db-schema.test.ts` — Schema unit test (2 tests).
- `db/migrations/0000_damp_kylun.sql` — Generated SQL migration.
- `package.json` — Added `db:generate` and `db:migrate` scripts.
- `pnpm-workspace.yaml` — Set `allowBuilds.esbuild: true` (needed by drizzle-kit).
- `.npmrc` — Created (enable-pre-post-scripts).

## TDD Evidence

### RED (schema test before schema existed)

```
pnpm exec vitest run tests/unit/db-schema.test.ts

FAIL  tests/unit/db-schema.test.ts
Error: Failed to resolve import "@/db/schema" from "tests/unit/db-schema.test.ts". Does the file exist?

Test Files  1 failed (1)
    Tests  no tests
```

### GREEN (after writing db/schema.ts)

```
pnpm exec vitest run tests/unit/db-schema.test.ts

Test Files  1 passed (1)
    Tests  2 passed (2)
  Duration  1.57s
```

## Migration Apply Output

```
pnpm db:generate
→ [✓] Your SQL migration file ➜ db/migrations/0000_damp_kylun.sql

pnpm db:migrate
→ Using '@neondatabase/serverless' driver for database querying
→ [✓] migrations applied successfully!
```

## Table Existence Verification (live Neon EU DB)

Query against `information_schema.columns` via `neon()` HTTP driver returned all 9 columns across both tables:

**tenants**: id (uuid), name (text), afm (text), address (text), subscription_state (text), created_at (timestamp with time zone)

**tenant_members**: user_id (text), tenant_id (uuid), role (text)

## Full Unit Test Suite

```
pnpm test

Test Files  2 passed (2)
    Tests  3 passed (3)
  Duration  1.48s
```

## Lint

```
pnpm lint
→ (clean, no output)
```

## Files Changed

- Created: `db/schema.ts`, `db/client.ts`, `drizzle.config.ts`
- Created: `tests/unit/db-schema.test.ts`
- Created: `db/migrations/0000_damp_kylun.sql`, `db/migrations/meta/` (drizzle-kit metadata)
- Modified: `package.json` (added db:generate, db:migrate scripts; deps drizzle-orm, @neondatabase/serverless, drizzle-kit, dotenv)
- Modified: `pnpm-workspace.yaml` (esbuild build allowed)
- Created: `.npmrc`

## Concerns

None. All steps completed cleanly.

- The `pnpm-workspace.yaml` `allowBuilds.esbuild: true` setting was required because pnpm 11 moved build-script allowlists from `package.json` to workspace config, and drizzle-kit requires esbuild.
- The `.env.local` fix (explicit `config({ path: '.env.local' })`) was applied as directed — without it, `drizzle-kit` would silently read from `.env` and fail to find `DATABASE_URL`.
