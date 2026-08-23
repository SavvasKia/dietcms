# Task 5 (RLS spike) — Path B: app-set GUC isolation

Proves tenant isolation at the DB layer WITHOUT Neon Authorize/JWTs. The request
path connects as the unprivileged `authenticated_backend` role; RLS policies read
`current_setting('app.user_id')`, which the app sets per transaction from the
validated Better Auth session. Owner (`neondb_owner`) is migrations/admin only.

## Already done (do NOT redo)
- Grants to `authenticated_backend` (USAGE on schema, CRUD on tables + sequences,
  default privileges for future tables) were run by hand in Neon as the owner.
- `DATABASE_URL_AUTHENTICATED` (authenticated_backend) and `DATABASE_URL` (owner)
  are both in `.env.local`.

## 1. Authenticated DB client + per-request tenant transaction
`db/authed-client.ts`:
```ts
import { drizzle } from 'drizzle-orm/neon-serverless'
import { Pool } from '@neondatabase/serverless'
import { sql } from 'drizzle-orm'
import * as schema from './schema'

// Pooled (WebSocket) driver — REQUIRED: the HTTP driver is stateless and cannot
// hold SET LOCAL across statements. This connects as the unprivileged
// authenticated_backend role, so RLS applies.
const authedPool = new Pool({ connectionString: process.env.DATABASE_URL_AUTHENTICATED! })
export const authedDb = drizzle(authedPool, { schema })

// Run `fn` inside a transaction where app.user_id is set to the current user, so
// RLS policies (current_setting('app.user_id')) see them. set_config(..., true)
// = transaction-local. Fails closed: if userId is empty, policies match nothing.
export async function withUser<T>(userId: string, fn: (tx: typeof authedDb) => Promise<T>): Promise<T> {
  return authedDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
    return fn(tx as unknown as typeof authedDb)
  })
}
```

## 2. Probe table + RLS policy (Drizzle schema → migration)
Append to `db/schema.ts`:
```ts
import { pgPolicy } from 'drizzle-orm/pg-core'
// (uuid, text, pgTable, sql already imported)

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    body: text('body').notNull(),
  },
  (t) => [
    pgPolicy('notes_tenant_isolation', {
      for: 'all',
      to: 'authenticated_backend',
      using: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
      withCheck: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
    }),
  ],
).enableRLS()
```
Generate the migration (`pnpm db:generate`). Then **hand-edit the generated migration
SQL** to also FORCE RLS (Drizzle emits ENABLE but not FORCE):
```sql
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;
```
Apply with `pnpm db:migrate`. Verify `notes` exists with RLS forced.
(NOTE for later, not this task: `tenants`/`tenant_members` are intentionally left
without RLS for the spike so the policy subquery can read the mapping; real domain
tables get their own RLS in later plans. Record this as a follow-up risk:
authenticated_backend can currently read all tenant_members rows.)

## 3. Integration test — NO JWTs needed
`vitest.integration.config.ts` (node env, include tests/integration). Add script
`"test:int": "vitest run --config vitest.integration.config.ts"`.

`tests/integration/rls-isolation.test.ts`:
- Use the OWNER client (`db` from `db/client.ts`) to seed two users+tenants:
  userA→tenantA, userB→tenantB (insert tenants, then tenant_members). Use unique
  ids per run (e.g. derive from a passed-in suffix) and clean up in afterAll.
- `withUser(userA, tx => tx.insert(notes).values({tenantId: tenantA, body:'A'}))` → ok; capture id.
- `withUser(userA, tx => tx.select().from(notes))` → INCLUDES the row.
- `withUser(userB, tx => tx.select().from(notes))` → EXCLUDES A's row.
- `withUser(userB, tx => tx.insert(notes).values({tenantId: tenantA, body:'evil'}))` → REJECTS (withCheck).
- Also assert: `withUser('', ...)` (empty/unknown user) sees zero rows (fail-closed).

Run: `pnpm test:int` → all assertions pass.

## GATE
If these pass, tenant isolation is PROVEN at the DB layer (a non-owner role cannot
cross tenants even with direct queries). If they cannot be made to pass, STOP and
report — the multi-tenant security model needs rework before any further build.

## Verify + commit
- `pnpm test` (unit suite still green), `pnpm typecheck` clean, `pnpm test:int` green.
- Commit: `feat: prove tenant isolation via RLS (Path B, app-set app.user_id)`.
- Report to `.superpowers/sdd/task-5-report.md`: migration applied + FORCE confirmed,
  the 5 isolation assertions with output, what role each path uses, follow-up risks.
