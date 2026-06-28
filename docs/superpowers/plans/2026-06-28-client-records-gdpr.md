# Client Records & GDPR Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build tenant-isolated client health records with recorded lawful basis, withdrawable consents, an append-only audit log, and operative GDPR export + erasure — on top of the shipped foundation.

**Architecture:** Three new RLS-protected tables (`clients`, `client_consents`, `audit_log`) following the foundation's Path B isolation model. Service modules in `lib/` (mirroring `lib/tenant.ts`) wrap every request-path query in `withUser()`. GDPR rights are a concrete export/erase service plus a schema-coverage test — no plugin registry. Erasure applies a per-table policy: delete clinical rows, anonymize audit rows.

**Tech Stack:** Next.js 16 App Router, Neon Postgres (EU), Drizzle ORM + drizzle-kit, Vitest (unit + integration), TypeScript.

## Global Constraints

- **EU data residency only** — all services already EU-region; do not add non-EU calls.
- **Secrets live in `.env.local`** (gitignored), never committed, never pasted in chat.
- **Every tenant-data access goes through `withUser(verifiedUserId, fn)`** (`db/authed-client.ts`). The owner client (`db` from `db/client.ts`) bypasses RLS and is for migrations/seeding/admin ONLY. The single sanctioned request-path exception is `audit_log` anonymization during erasure (the request role has no UPDATE grant on `audit_log` by design) — documented in Task 5.
- **Never call `withUser()` / `authedDb.transaction()` nested** inside another `withUser` `fn` — it opens a new pooled connection without the GUC and loses RLS context (see warning in `db/authed-client.ts`).
- **Every new table with `tenant_id`** gets its own `*_tenant_isolation` RLS policy (the `notes` pattern), `enableRLS()` in schema, and a hand-edited migration adding `FORCE ROW LEVEL SECURITY`. Fail-closed.
- **No PII / special-category data to Sentry or PostHog.** `audit_log.metadata` must be PII-free, enforced via the shared `lib/pii-denylist`.
- **Lawful basis ≠ consent.** Clinical data uses Art 9(2)(h) recorded as a fact (`clients.lawful_basis`); consents are only for optional processing.
- **TDD, DRY, YAGNI, frequent commits.** One logical change per commit.
- **Migrations:** `pnpm db:generate` then hand-edit the generated SQL for `FORCE` / `REVOKE`, then `pnpm db:migrate`. drizzle.config loads `.env.local`.

---

## File Structure

- `db/schema.ts` — append `clients`, `clientConsents`, `auditLog` table defs + RLS policies.
- `db/migrations/000X_*.sql` — generated per table-adding task, hand-edited for FORCE/REVOKE.
- `lib/clients.ts` — client CRUD + soft-delete service.
- `lib/audit.ts` — single audit writer.
- `lib/consents.ts` — consent grant/withdraw/active service.
- `lib/gdpr.ts` — export + erasure service.
- `tests/unit/clients-schema.test.ts` — schema column assertions.
- `tests/unit/consents.test.ts` — consent state-machine logic (pure where possible).
- `tests/integration/clients-rls.test.ts` — per-table RLS isolation.
- `tests/integration/audit-append-only.test.ts` — request role cannot UPDATE/DELETE audit_log.
- `tests/integration/consents-rls.test.ts` — consent RLS + service behavior on live DB.
- `tests/integration/gdpr.test.ts` — export completeness + erasure per-table policy.
- `tests/unit/gdpr-coverage.test.ts` — schema-coverage forcing-test.

---

## Task 1: `clients` table + RLS + isolation test

**Files:**
- Modify: `db/schema.ts` (append `clients`)
- Create: `db/migrations/` (generated)
- Test: `tests/unit/clients-schema.test.ts`, `tests/integration/clients-rls.test.ts`

**Interfaces:**
- Consumes: `tenants`, `tenantMembers` from `db/schema.ts`; `withUser` from `db/authed-client.ts`; `db` from `db/client.ts`.
- Produces: `clients` table export from `db/schema.ts` with columns `id, tenantId, firstName, lastName, dob, sex, email, phone, address, afm, medicalHistory, allergies, goals, notes, lawfulBasis, createdAt, updatedAt, deletedAt`.

- [ ] **Step 1: Write the failing schema unit test**

`tests/unit/clients-schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { clients } from '@/db/schema'
import { getTableConfig } from 'drizzle-orm/pg-core'

describe('clients schema', () => {
  it('has the required client columns', () => {
    const cols = getTableConfig(clients).columns.map((c) => c.name)
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'tenant_id', 'first_name', 'last_name', 'dob', 'sex',
        'email', 'phone', 'address', 'afm', 'medical_history', 'allergies',
        'goals', 'notes', 'lawful_basis', 'created_at', 'updated_at', 'deleted_at',
      ]),
    )
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test -- clients-schema`
Expected: FAIL — `clients` is not exported from `@/db/schema`.

- [ ] **Step 3: Add the `clients` table to `db/schema.ts`**

Add imports at top if missing (`date`, `timestamp` already imported; add `date`):
```ts
import { pgTable, uuid, text, timestamp, date, primaryKey, unique } from 'drizzle-orm/pg-core'
```
Append:
```ts
export const clients = pgTable(
  'clients',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    dob: date('dob'),
    sex: text('sex'),
    email: text('email'),
    phone: text('phone'),
    address: text('address'),
    afm: text('afm'),
    medicalHistory: text('medical_history'),
    allergies: text('allergies').array().notNull().default(sql`'{}'`),
    goals: text('goals'),
    notes: text('notes'),
    lawfulBasis: text('lawful_basis').notNull().default('art_9_2_h_healthcare'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    pgPolicy('clients_tenant_isolation', {
      for: 'all',
      to: 'authenticated_backend',
      using: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
      withCheck: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
    }),
  ],
).enableRLS()
```

- [ ] **Step 4: Run schema test, verify it passes**

Run: `pnpm test -- clients-schema`
Expected: PASS.

- [ ] **Step 5: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `db/migrations/000X_*.sql` containing `CREATE TABLE "clients"`, `ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY`, and the `clients_tenant_isolation` policy.

- [ ] **Step 6: Hand-edit the migration to add FORCE**

Open the generated SQL file. After the `ENABLE ROW LEVEL SECURITY` line for `clients`, add:
```sql
ALTER TABLE "clients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
```

- [ ] **Step 7: Apply the migration**

Run: `pnpm db:migrate`
Expected: applies cleanly. (Future-table default privileges already grant `authenticated_backend` CRUD on `clients`.)

- [ ] **Step 8: Write the RLS isolation integration test**

`tests/integration/clients-rls.test.ts`:
```ts
/** clients RLS isolation (Path B). Seeds via owner; asserts via withUser. */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { db } from '../../db/client'
import { withUser } from '../../db/authed-client'
import { tenants, tenantMembers, clients } from '../../db/schema'
import { eq, or } from 'drizzle-orm'

const run = Date.now().toString(36)
const userA = `cli-a-${run}`
const userB = `cli-b-${run}`
let tenantIdA: string
let tenantIdB: string
let clientIdA: string

describe('clients RLS isolation', () => {
  beforeAll(async () => {
    const [tA] = await db.insert(tenants).values({ name: `CT A ${run}` }).returning()
    const [tB] = await db.insert(tenants).values({ name: `CT B ${run}` }).returning()
    tenantIdA = tA.id
    tenantIdB = tB.id
    await db.insert(tenantMembers).values([
      { userId: userA, tenantId: tenantIdA, role: 'owner' },
      { userId: userB, tenantId: tenantIdB, role: 'owner' },
    ])
  })

  afterAll(async () => {
    await db.delete(clients).where(or(eq(clients.tenantId, tenantIdA), eq(clients.tenantId, tenantIdB)))
    await db.delete(tenantMembers).where(or(eq(tenantMembers.userId, userA), eq(tenantMembers.userId, userB)))
    await db.delete(tenants).where(or(eq(tenants.id, tenantIdA), eq(tenants.id, tenantIdB)))
  })

  it('userA inserts a client into their own tenant', async () => {
    const [row] = await withUser(userA, (tx) =>
      tx.insert(clients).values({ tenantId: tenantIdA, firstName: 'Maria', lastName: 'P' }).returning(),
    )
    expect(row.id).toBeTruthy()
    clientIdA = row.id
  })

  it('userA sees their own client', async () => {
    const rows = await withUser(userA, (tx) => tx.select().from(clients))
    expect(rows.map((r) => r.id)).toContain(clientIdA)
  })

  it("userB does NOT see userA's client", async () => {
    const rows = await withUser(userB, (tx) => tx.select().from(clients))
    expect(rows.map((r) => r.id)).not.toContain(clientIdA)
  })

  it('cross-tenant insert is rejected by WITH CHECK', async () => {
    await expect(
      withUser(userB, (tx) =>
        tx.insert(clients).values({ tenantId: tenantIdA, firstName: 'evil', lastName: 'x' }),
      ),
    ).rejects.toThrow()
  })

  it('empty userId sees zero rows (fail-closed)', async () => {
    const rows = await withUser('', (tx) => tx.select().from(clients))
    expect(rows.length).toBe(0)
  })
})
```

- [ ] **Step 9: Run the integration test**

Run: `pnpm test:int -- clients-rls`
Expected: all 5 pass.

- [ ] **Step 10: Commit**

```bash
git add db/schema.ts db/migrations tests/unit/clients-schema.test.ts tests/integration/clients-rls.test.ts
git commit -m "feat: clients table with RLS tenant isolation"
```

---

## Task 2: client-service CRUD + soft-delete

**Files:**
- Create: `lib/clients.ts`
- Test: `tests/integration/clients-rls.test.ts` (extend with service-level cases)

**Interfaces:**
- Consumes: `clients`, `tenantMembers` from schema; `withUser` from `db/authed-client.ts`.
- Produces:
  - `type NewClient = { firstName: string; lastName: string; dob?: string; sex?: string; email?: string; phone?: string; address?: string; afm?: string; medicalHistory?: string; allergies?: string[]; goals?: string; notes?: string }`
  - `createClient(userId: string, input: NewClient): Promise<typeof clients.$inferSelect>`
  - `getClient(userId: string, clientId: string): Promise<typeof clients.$inferSelect | null>` (excludes soft-deleted)
  - `listClients(userId: string): Promise<(typeof clients.$inferSelect)[]>` (excludes soft-deleted)
  - `updateClient(userId: string, clientId: string, patch: Partial<NewClient>): Promise<typeof clients.$inferSelect | null>`
  - `softDeleteClient(userId: string, clientId: string): Promise<boolean>`

> Note: services resolve the caller's `tenant_id` *inside* the `withUser` transaction by reading `tenant_members` (RLS returns only the caller's row) — callers never pass `tenantId`.

- [ ] **Step 1: Write the failing service test**

Append to `tests/integration/clients-rls.test.ts` a new `describe`:
```ts
import { createClient, getClient, listClients, updateClient, softDeleteClient } from '../../lib/clients'

describe('client-service', () => {
  const run2 = `${Date.now().toString(36)}-svc`
  const userS = `cli-s-${run2}`
  let tenantIdS: string
  let createdId: string

  beforeAll(async () => {
    const [tS] = await db.insert(tenants).values({ name: `CT S ${run2}` }).returning()
    tenantIdS = tS.id
    await db.insert(tenantMembers).values({ userId: userS, tenantId: tenantIdS, role: 'owner' })
  })
  afterAll(async () => {
    await db.delete(clients).where(eq(clients.tenantId, tenantIdS))
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, userS))
    await db.delete(tenants).where(eq(tenants.id, tenantIdS))
  })

  it('createClient sets tenant_id from the caller and returns the row', async () => {
    const c = await createClient(userS, { firstName: 'Nikos', lastName: 'K', allergies: ['peanuts'] })
    expect(c.tenantId).toBe(tenantIdS)
    expect(c.allergies).toEqual(['peanuts'])
    createdId = c.id
  })

  it('getClient returns the created client', async () => {
    const c = await getClient(userS, createdId)
    expect(c?.firstName).toBe('Nikos')
  })

  it('updateClient patches fields', async () => {
    const c = await updateClient(userS, createdId, { goals: 'lose 5kg' })
    expect(c?.goals).toBe('lose 5kg')
  })

  it('softDeleteClient hides the client from get/list', async () => {
    const ok = await softDeleteClient(userS, createdId)
    expect(ok).toBe(true)
    expect(await getClient(userS, createdId)).toBeNull()
    expect((await listClients(userS)).map((r) => r.id)).not.toContain(createdId)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test:int -- clients-rls`
Expected: FAIL — `lib/clients` has no such exports.

- [ ] **Step 3: Implement `lib/clients.ts`**

```ts
import { and, eq, isNull } from 'drizzle-orm'
import { withUser } from '@/db/authed-client'
import { clients, tenantMembers } from '@/db/schema'

export type NewClient = {
  firstName: string
  lastName: string
  dob?: string
  sex?: string
  email?: string
  phone?: string
  address?: string
  afm?: string
  medicalHistory?: string
  allergies?: string[]
  goals?: string
  notes?: string
}

type Client = typeof clients.$inferSelect

// Reads the caller's tenant_id from tenant_members under RLS (returns only the
// caller's own row). Throws if the caller has no membership — fail-closed.
async function callerTenantId(tx: typeof import('@/db/authed-client').authedDb): Promise<string> {
  const [m] = await tx.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).limit(1)
  if (!m) throw new Error('no tenant for user')
  return m.tenantId
}

export function createClient(userId: string, input: NewClient): Promise<Client> {
  return withUser(userId, async (tx) => {
    const tenantId = await callerTenantId(tx)
    const [row] = await tx
      .insert(clients)
      .values({ ...input, tenantId })
      .returning()
    return row
  })
}

export function getClient(userId: string, clientId: string): Promise<Client | null> {
  return withUser(userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(clients)
      .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
      .limit(1)
    return row ?? null
  })
}

export function listClients(userId: string): Promise<Client[]> {
  return withUser(userId, (tx) =>
    tx.select().from(clients).where(isNull(clients.deletedAt)),
  )
}

export function updateClient(
  userId: string,
  clientId: string,
  patch: Partial<NewClient>,
): Promise<Client | null> {
  return withUser(userId, async (tx) => {
    const [row] = await tx
      .update(clients)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
      .returning()
    return row ?? null
  })
}

export function softDeleteClient(userId: string, clientId: string): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .update(clients)
      .set({ deletedAt: new Date() })
      .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
      .returning({ id: clients.id })
    return rows.length > 0
  })
}
```

- [ ] **Step 4: Run the service test, verify it passes**

Run: `pnpm test:int -- clients-rls`
Expected: all pass.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/clients.ts tests/integration/clients-rls.test.ts
git commit -m "feat: client-service CRUD with soft-delete"
```

---

## Task 3: `audit_log` table (append-only) + audit-service wired into client-service

**Files:**
- Modify: `db/schema.ts` (append `auditLog`)
- Modify: `db/migrations/` (generated + hand-edited REVOKE)
- Create: `lib/audit.ts`
- Modify: `lib/clients.ts` (write audit rows on mutations + single-client read)
- Test: `tests/integration/audit-append-only.test.ts`

**Interfaces:**
- Consumes: `withUser` from `db/authed-client.ts`; `isDenied` from `@/lib/pii-denylist`; `db` from `db/client.ts`.
- Produces:
  - `auditLog` table with columns `id, tenantId, actorUserId, action, entity, entityId, clientId, at, metadata`.
  - `type AuditAction = 'view' | 'create' | 'update' | 'delete' | 'export' | 'erase'`
  - `recordAudit(tx, args: { action: AuditAction; entity: string; entityId?: string | null; clientId?: string | null; metadata?: Record<string, unknown> | null }): Promise<void>` — takes an existing `withUser` transaction (so it shares the RLS context; never opens its own).

- [ ] **Step 1: Write the failing append-only integration test**

`tests/integration/audit-append-only.test.ts`:
```ts
/** audit_log is append-only for the request role; isolated per tenant. */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { db } from '../../db/client'
import { withUser } from '../../db/authed-client'
import { tenants, tenantMembers, auditLog } from '../../db/schema'
import { eq, sql } from 'drizzle-orm'

const run = Date.now().toString(36)
const userA = `aud-a-${run}`
let tenantIdA: string
let auditId: string

describe('audit_log append-only + isolation', () => {
  beforeAll(async () => {
    const [tA] = await db.insert(tenants).values({ name: `AUD A ${run}` }).returning()
    tenantIdA = tA.id
    await db.insert(tenantMembers).values({ userId: userA, tenantId: tenantIdA, role: 'owner' })
    const [row] = await db
      .insert(auditLog)
      .values({ tenantId: tenantIdA, actorUserId: userA, action: 'create', entity: 'client' })
      .returning()
    auditId = row.id
  })
  afterAll(async () => {
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenantIdA))
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, userA))
    await db.delete(tenants).where(eq(tenants.id, tenantIdA))
  })

  it('request role can INSERT audit rows', async () => {
    const [row] = await withUser(userA, (tx) =>
      tx.insert(auditLog).values({ tenantId: tenantIdA, actorUserId: userA, action: 'view', entity: 'client' }).returning(),
    )
    expect(row.id).toBeTruthy()
  })

  it('request role can SELECT its own tenant audit rows', async () => {
    const rows = await withUser(userA, (tx) => tx.select().from(auditLog))
    expect(rows.length).toBeGreaterThan(0)
  })

  it('request role CANNOT UPDATE audit rows', async () => {
    await expect(
      withUser(userA, (tx) =>
        tx.execute(sql`update audit_log set action = 'view' where id = ${auditId}`),
      ),
    ).rejects.toThrow()
  })

  it('request role CANNOT DELETE audit rows', async () => {
    await expect(
      withUser(userA, (tx) => tx.execute(sql`delete from audit_log where id = ${auditId}`)),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test:int -- audit-append-only`
Expected: FAIL — `auditLog` not exported.

- [ ] **Step 3: Add `auditLog` to `db/schema.ts`**

Add `jsonb` to the pg-core import. Append:
```ts
import { pgTable, uuid, text, timestamp, date, jsonb, primaryKey, unique } from 'drizzle-orm/pg-core'

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    actorUserId: text('actor_user_id').notNull(),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id'),
    clientId: uuid('client_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata'),
  },
  (t) => [
    pgPolicy('audit_log_tenant_isolation', {
      for: 'all',
      to: 'authenticated_backend',
      using: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
      withCheck: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
    }),
  ],
).enableRLS()
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: new SQL with `CREATE TABLE "audit_log"`, ENABLE RLS, policy.

- [ ] **Step 5: Hand-edit the migration — add FORCE and REVOKE UPDATE/DELETE**

In the generated SQL, after `audit_log` `ENABLE ROW LEVEL SECURITY`, add:
```sql
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE UPDATE, DELETE ON "audit_log" FROM "authenticated_backend";--> statement-breakpoint
```
(Default privileges granted CRUD to `authenticated_backend` on new tables; this revokes the two that break append-only. INSERT + SELECT remain.)

- [ ] **Step 6: Apply the migration**

Run: `pnpm db:migrate`
Expected: clean.

- [ ] **Step 7: Run the append-only test, verify it passes**

Run: `pnpm test:int -- audit-append-only`
Expected: all 4 pass (the UPDATE/DELETE cases reject with a permission error).

- [ ] **Step 8: Implement `lib/audit.ts`**

```ts
import { sql } from 'drizzle-orm'
import { auditLog, tenantMembers } from '@/db/schema'
import { isDenied } from '@/lib/pii-denylist'

export type AuditAction = 'view' | 'create' | 'update' | 'delete' | 'export' | 'erase'

type AuditTx = {
  select: (...a: unknown[]) => any
  insert: (...a: unknown[]) => any
}

// Writes a single audit row inside an EXISTING withUser transaction (shares RLS
// context — must never open its own connection). Rejects PII in metadata keys.
export async function recordAudit(
  tx: any,
  args: {
    action: AuditAction
    entity: string
    entityId?: string | null
    clientId?: string | null
    metadata?: Record<string, unknown> | null
  },
): Promise<void> {
  if (args.metadata) {
    for (const key of Object.keys(args.metadata)) {
      if (isDenied(key)) throw new Error(`audit metadata key "${key}" is PII-denylisted`)
    }
  }
  const [m] = await tx.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).limit(1)
  if (!m) throw new Error('no tenant for user')
  await tx.insert(auditLog).values({
    tenantId: m.tenantId,
    actorUserId: sql`current_setting('app.user_id', true)`,
    action: args.action,
    entity: args.entity,
    entityId: args.entityId ?? null,
    clientId: args.clientId ?? null,
    metadata: args.metadata ?? null,
  })
}
```

- [ ] **Step 9: Wire audit into `lib/clients.ts`**

In each mutating method and `getClient`, call `recordAudit` within the same transaction. Updated bodies:
```ts
import { recordAudit } from '@/lib/audit'

// createClient: after insert
//   await recordAudit(tx, { action: 'create', entity: 'client', entityId: row.id, clientId: row.id })
// getClient: after fetch, if row exists
//   await recordAudit(tx, { action: 'view', entity: 'client', entityId: clientId, clientId })
// updateClient: after update, if row exists
//   await recordAudit(tx, { action: 'update', entity: 'client', entityId: clientId, clientId })
// softDeleteClient: after update, if rows.length > 0
//   await recordAudit(tx, { action: 'delete', entity: 'client', entityId: clientId, clientId })
```
Apply these literally — full `createClient` example:
```ts
export function createClient(userId: string, input: NewClient): Promise<Client> {
  return withUser(userId, async (tx) => {
    const tenantId = await callerTenantId(tx)
    const [row] = await tx.insert(clients).values({ ...input, tenantId }).returning()
    await recordAudit(tx, { action: 'create', entity: 'client', entityId: row.id, clientId: row.id })
    return row
  })
}
```
(Do the same for `getClient`, `updateClient`, `softDeleteClient`, guarding the audit call so it only fires when a row was actually read/changed.)

- [ ] **Step 10: Add a service-level audit assertion to the test**

Append to `tests/integration/audit-append-only.test.ts`:
```ts
import { createClient } from '../../lib/clients'
import { clients } from '../../db/schema'

describe('client-service writes audit rows', () => {
  const run2 = `${Date.now().toString(36)}-cw`
  const userW = `aud-w-${run2}`
  let tenantIdW: string
  beforeAll(async () => {
    const [tW] = await db.insert(tenants).values({ name: `AUD W ${run2}` }).returning()
    tenantIdW = tW.id
    await db.insert(tenantMembers).values({ userId: userW, tenantId: tenantIdW, role: 'owner' })
  })
  afterAll(async () => {
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenantIdW))
    await db.delete(clients).where(eq(clients.tenantId, tenantIdW))
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, userW))
    await db.delete(tenants).where(eq(tenants.id, tenantIdW))
  })
  it('creating a client writes a create audit row referencing the client', async () => {
    const c = await createClient(userW, { firstName: 'Eleni', lastName: 'D' })
    const rows = await withUser(userW, (tx) => tx.select().from(auditLog))
    const createRow = rows.find((r) => r.action === 'create' && r.clientId === c.id)
    expect(createRow).toBeTruthy()
    expect(createRow?.actorUserId).toBe(userW)
  })
})
```

- [ ] **Step 11: Run tests + typecheck**

Run: `pnpm test:int -- audit-append-only` then `pnpm typecheck`
Expected: all pass, clean.

- [ ] **Step 12: Commit**

```bash
git add db/schema.ts db/migrations lib/audit.ts lib/clients.ts tests/integration/audit-append-only.test.ts
git commit -m "feat: append-only audit_log + audit on client mutations"
```

---

## Task 4: `client_consents` table + consent-service

**Files:**
- Modify: `db/schema.ts` (append `clientConsents`)
- Modify: `db/migrations/` (generated + FORCE)
- Create: `lib/consents.ts`
- Test: `tests/integration/consents-rls.test.ts`

**Interfaces:**
- Consumes: `clients`, `clientConsents`, `tenantMembers` from schema; `withUser`; `recordAudit` from `@/lib/audit`.
- Produces:
  - `clientConsents` table: `id, tenantId, clientId, scope, grantedAt, withdrawnAt, textVersion`.
  - `type ConsentScope = 'email_comms' | 'marketing' | 'third_party_sharing' | 'portal_access'`
  - `grantConsent(userId, clientId, scope: ConsentScope, textVersion: string): Promise<typeof clientConsents.$inferSelect>`
  - `withdrawConsent(userId, clientId, scope: ConsentScope): Promise<boolean>` (sets `withdrawnAt` on the latest active row for that scope)
  - `activeConsents(userId, clientId): Promise<ConsentScope[]>` (scopes whose latest row has `withdrawnAt is null`)

- [ ] **Step 1: Write the failing integration test**

`tests/integration/consents-rls.test.ts`:
```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { db } from '../../db/client'
import { withUser } from '../../db/authed-client'
import { tenants, tenantMembers, clients, clientConsents } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { grantConsent, withdrawConsent, activeConsents } from '../../lib/consents'
import { createClient } from '../../lib/clients'

const run = Date.now().toString(36)
const userA = `con-a-${run}`
let tenantIdA: string
let clientId: string

describe('consent-service', () => {
  beforeAll(async () => {
    const [tA] = await db.insert(tenants).values({ name: `CON A ${run}` }).returning()
    tenantIdA = tA.id
    await db.insert(tenantMembers).values({ userId: userA, tenantId: tenantIdA, role: 'owner' })
    const c = await createClient(userA, { firstName: 'Sofia', lastName: 'M' })
    clientId = c.id
  })
  afterAll(async () => {
    await db.delete(clientConsents).where(eq(clientConsents.tenantId, tenantIdA))
    await db.delete(clients).where(eq(clients.tenantId, tenantIdA))
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, userA))
    await db.delete(tenants).where(eq(tenants.id, tenantIdA))
  })

  it('grant then active returns the scope', async () => {
    await grantConsent(userA, clientId, 'email_comms', 'v1-el')
    expect(await activeConsents(userA, clientId)).toContain('email_comms')
  })

  it('withdraw removes it from active', async () => {
    await withdrawConsent(userA, clientId, 'email_comms')
    expect(await activeConsents(userA, clientId)).not.toContain('email_comms')
  })

  it('re-grant after withdrawal makes it active again (latest row wins)', async () => {
    await grantConsent(userA, clientId, 'email_comms', 'v2-el')
    expect(await activeConsents(userA, clientId)).toContain('email_comms')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test:int -- consents-rls`
Expected: FAIL — `clientConsents` / `lib/consents` missing.

- [ ] **Step 3: Add `clientConsents` to `db/schema.ts`**

```ts
export const clientConsents = pgTable(
  'client_consents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    textVersion: text('text_version').notNull(),
  },
  (t) => [
    pgPolicy('client_consents_tenant_isolation', {
      for: 'all',
      to: 'authenticated_backend',
      using: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
      withCheck: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
    }),
  ],
).enableRLS()
```

- [ ] **Step 4: Generate, hand-edit FORCE, apply**

```
pnpm db:generate
```
Add to the generated SQL after `client_consents` ENABLE RLS:
```sql
ALTER TABLE "client_consents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
```
Then:
```
pnpm db:migrate
```

- [ ] **Step 5: Implement `lib/consents.ts`**

```ts
import { and, desc, eq, isNull } from 'drizzle-orm'
import { withUser } from '@/db/authed-client'
import { clientConsents, tenantMembers } from '@/db/schema'
import { recordAudit } from '@/lib/audit'

export type ConsentScope = 'email_comms' | 'marketing' | 'third_party_sharing' | 'portal_access'
const SCOPES: ConsentScope[] = ['email_comms', 'marketing', 'third_party_sharing', 'portal_access']

type Consent = typeof clientConsents.$inferSelect

export function grantConsent(
  userId: string,
  clientId: string,
  scope: ConsentScope,
  textVersion: string,
): Promise<Consent> {
  return withUser(userId, async (tx) => {
    const [m] = await tx.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).limit(1)
    if (!m) throw new Error('no tenant for user')
    const [row] = await tx
      .insert(clientConsents)
      .values({ tenantId: m.tenantId, clientId, scope, textVersion })
      .returning()
    await recordAudit(tx, { action: 'create', entity: 'consent', entityId: row.id, clientId, metadata: { scope } })
    return row
  })
}

export function withdrawConsent(userId: string, clientId: string, scope: ConsentScope): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const [latest] = await tx
      .select({ id: clientConsents.id })
      .from(clientConsents)
      .where(
        and(
          eq(clientConsents.clientId, clientId),
          eq(clientConsents.scope, scope),
          isNull(clientConsents.withdrawnAt),
        ),
      )
      .orderBy(desc(clientConsents.grantedAt))
      .limit(1)
    if (!latest) return false
    await tx.update(clientConsents).set({ withdrawnAt: new Date() }).where(eq(clientConsents.id, latest.id))
    await recordAudit(tx, { action: 'update', entity: 'consent', entityId: latest.id, clientId, metadata: { scope, withdrawn: true } })
    return true
  })
}

export function activeConsents(userId: string, clientId: string): Promise<ConsentScope[]> {
  return withUser(userId, async (tx) => {
    const active: ConsentScope[] = []
    for (const scope of SCOPES) {
      const [latest] = await tx
        .select({ withdrawnAt: clientConsents.withdrawnAt })
        .from(clientConsents)
        .where(and(eq(clientConsents.clientId, clientId), eq(clientConsents.scope, scope)))
        .orderBy(desc(clientConsents.grantedAt))
        .limit(1)
      if (latest && latest.withdrawnAt === null) active.push(scope)
    }
    return active
  })
}
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `pnpm test:int -- consents-rls`
Expected: all 3 pass.

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm typecheck
git add db/schema.ts db/migrations lib/consents.ts tests/integration/consents-rls.test.ts
git commit -m "feat: client_consents table + consent grant/withdraw service"
```

---

## Task 5: GDPR export + erasure service

**Files:**
- Create: `lib/gdpr.ts`
- Test: `tests/integration/gdpr.test.ts`

**Interfaces:**
- Consumes: `clients`, `clientConsents`, `auditLog`, `tenantMembers` from schema; `withUser`; `db` (owner) from `db/client.ts`; `recordAudit`.
- Produces:
  - `type ClientExport = { client: typeof clients.$inferSelect; consents: (typeof clientConsents.$inferSelect)[]; auditLog: (typeof auditLog.$inferSelect)[] }`
  - `exportClient(userId, clientId): Promise<ClientExport | null>`
  - `eraseClient(userId, clientId): Promise<boolean>`

**Erasure per-table policy (explicit):**
- `clients` → hard delete the row.
- `client_consents` → hard delete (FK cascade also covers it; delete explicitly for clarity).
- `audit_log` → **anonymize, not delete**: null `client_id`, `entity_id`, `metadata`; retain row, action, at, actor. Runs on the **owner connection** (`db`) because the request role has no UPDATE grant on `audit_log` (Task 3). This is the one sanctioned owner-path write in the request flow — filtered by the specific `client_id` uuid so it cannot touch other clients.

- [ ] **Step 1: Write the failing test**

`tests/integration/gdpr.test.ts`:
```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { db } from '../../db/client'
import { withUser } from '../../db/authed-client'
import { tenants, tenantMembers, clients, clientConsents, auditLog } from '../../db/schema'
import { eq, and } from 'drizzle-orm'
import { createClient } from '../../lib/clients'
import { grantConsent } from '../../lib/consents'
import { exportClient, eraseClient } from '../../lib/gdpr'

const run = Date.now().toString(36)
const userA = `gdpr-a-${run}`
let tenantIdA: string
let clientId: string

describe('gdpr export + erasure', () => {
  beforeAll(async () => {
    const [tA] = await db.insert(tenants).values({ name: `GDPR A ${run}` }).returning()
    tenantIdA = tA.id
    await db.insert(tenantMembers).values({ userId: userA, tenantId: tenantIdA, role: 'owner' })
    const c = await createClient(userA, { firstName: 'Giorgos', lastName: 'V', notes: 'clinical note' })
    clientId = c.id
    await grantConsent(userA, clientId, 'email_comms', 'v1-el')
  })
  afterAll(async () => {
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenantIdA))
    await db.delete(clientConsents).where(eq(clientConsents.tenantId, tenantIdA))
    await db.delete(clients).where(eq(clients.tenantId, tenantIdA))
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, userA))
    await db.delete(tenants).where(eq(tenants.id, tenantIdA))
  })

  it('exportClient returns client + consents + audit rows', async () => {
    const dump = await exportClient(userA, clientId)
    expect(dump?.client.id).toBe(clientId)
    expect(dump?.consents.length).toBeGreaterThan(0)
    expect(dump?.auditLog.length).toBeGreaterThan(0)
  })

  it('eraseClient deletes clinical rows and anonymizes audit rows', async () => {
    const ok = await eraseClient(userA, clientId)
    expect(ok).toBe(true)

    // clinical rows gone (owner view, bypasses RLS)
    const c = await db.select().from(clients).where(eq(clients.id, clientId))
    expect(c.length).toBe(0)
    const cons = await db.select().from(clientConsents).where(eq(clientConsents.clientId, clientId))
    expect(cons.length).toBe(0)

    // audit rows retained but anonymized: none still reference the client_id
    const stillRef = await db.select().from(auditLog).where(eq(auditLog.clientId, clientId))
    expect(stillRef.length).toBe(0)
    // and at least one audit row for this tenant survives (retained, anonymized)
    const survivors = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantIdA))
    expect(survivors.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm test:int -- gdpr`
Expected: FAIL — `lib/gdpr` missing.

- [ ] **Step 3: Implement `lib/gdpr.ts`**

```ts
import { eq } from 'drizzle-orm'
import { withUser } from '@/db/authed-client'
import { db } from '@/db/client'
import { clients, clientConsents, auditLog } from '@/db/schema'
import { recordAudit } from '@/lib/audit'

export type ClientExport = {
  client: typeof clients.$inferSelect
  consents: (typeof clientConsents.$inferSelect)[]
  auditLog: (typeof auditLog.$inferSelect)[]
}

export function exportClient(userId: string, clientId: string): Promise<ClientExport | null> {
  return withUser(userId, async (tx) => {
    const [client] = await tx.select().from(clients).where(eq(clients.id, clientId)).limit(1)
    if (!client) return null
    const consents = await tx.select().from(clientConsents).where(eq(clientConsents.clientId, clientId))
    const audit = await tx.select().from(auditLog).where(eq(auditLog.clientId, clientId))
    await recordAudit(tx, { action: 'export', entity: 'client', entityId: clientId, clientId })
    return { client, consents, auditLog: audit }
  })
}

// Erasure per-table policy. Clinical rows deleted via the request path (RLS
// confirms ownership). Audit rows ANONYMIZED via the owner connection, since the
// request role has no UPDATE grant on audit_log (append-only). Filtered by the
// specific client_id uuid, so no other client is touched.
export async function eraseClient(userId: string, clientId: string): Promise<boolean> {
  const deleted = await withUser(userId, async (tx) => {
    // confirm the caller can see (owns) this client before erasing
    const [client] = await tx.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId)).limit(1)
    if (!client) return false
    await tx.delete(clientConsents).where(eq(clientConsents.clientId, clientId))
    await tx.delete(clients).where(eq(clients.id, clientId))
    // record erase BEFORE anonymizing, so this row is itself anonymized below
    await recordAudit(tx, { action: 'erase', entity: 'client', entityId: clientId, clientId })
    return true
  })
  if (!deleted) return false

  // Anonymize all audit rows for this data subject (owner path). Retain the row,
  // action, at, actor — null only the data-subject references.
  await db
    .update(auditLog)
    .set({ clientId: null, entityId: null, metadata: null })
    .where(eq(auditLog.clientId, clientId))

  return true
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm test:int -- gdpr`
Expected: both pass.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add lib/gdpr.ts tests/integration/gdpr.test.ts
git commit -m "feat: GDPR export + erasure (per-table policy)"
```

---

## Task 6: GDPR coverage forcing-test

**Files:**
- Create: `tests/unit/gdpr-coverage.test.ts`
- Modify (only if the test reveals a gap): `lib/gdpr.ts`

**Interfaces:**
- Consumes: Drizzle schema metadata (`getTableConfig`) for every table; the source of `lib/gdpr.ts`.

**Goal:** A test that goes red when a future module adds a `client_id`-bearing table without wiring it into export + erasure. At n=1 the covered set is `{clients, client_consents, audit_log}`.

- [ ] **Step 1: Write the coverage test**

`tests/unit/gdpr-coverage.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { getTableConfig } from 'drizzle-orm/pg-core'
import * as schema from '@/db/schema'

// Tables that hold data about a client: the `clients` root plus any table with a
// `client_id` column. Every one MUST be referenced by both export and erasure in
// lib/gdpr.ts. A new uncovered table turns this test red.
function clientScopedTables(): string[] {
  const names: string[] = []
  for (const value of Object.values(schema)) {
    // drizzle table objects work with getTableConfig; skip everything else
    let cfg
    try {
      cfg = getTableConfig(value as never)
    } catch {
      continue
    }
    const cols = cfg.columns.map((c) => c.name)
    if (cfg.name === 'clients' || cols.includes('client_id')) {
      names.push(cfg.name)
    }
  }
  return names
}

describe('GDPR coverage', () => {
  const src = readFileSync(new URL('../../lib/gdpr.ts', import.meta.url), 'utf8')

  it('every client-scoped table is referenced in lib/gdpr.ts', () => {
    const tables = clientScopedTables()
    expect(tables).toEqual(expect.arrayContaining(['clients', 'client_consents', 'audit_log']))
    // map table name -> drizzle export identifier used in gdpr.ts
    const tableToIdent: Record<string, string> = {
      clients: 'clients',
      client_consents: 'clientConsents',
      audit_log: 'auditLog',
    }
    for (const t of tables) {
      const ident = tableToIdent[t]
      expect(
        ident,
        `No known gdpr.ts identifier for table "${t}". A new client-scoped table was added — wire it into exportClient + eraseClient and register its identifier here.`,
      ).toBeTruthy()
      expect(src.includes(ident)).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run it, verify it passes**

Run: `pnpm test -- gdpr-coverage`
Expected: PASS — all three identifiers appear in `lib/gdpr.ts`.

- [ ] **Step 3: Prove the forcing behavior (manual sanity, then revert)**

Temporarily add a throwaway table with a `client_id` column to `db/schema.ts` (do NOT migrate), e.g.:
```ts
export const _coverageProbe = pgTable('coverage_probe', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: uuid('client_id'),
})
```
Run: `pnpm test -- gdpr-coverage`
Expected: FAIL — `coverage_probe` has no known identifier / is not referenced. This proves the guard works. Then **delete `_coverageProbe`** and re-run — PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/gdpr-coverage.test.ts
git commit -m "test: GDPR coverage forcing-test for client-scoped tables"
```

---

## Final verification (before whole-branch review)

- `pnpm test` — all unit tests green.
- `pnpm test:int` — all integration tests green (RLS isolation per table, audit append-only, consent lifecycle, GDPR export/erase).
- `pnpm typecheck` — clean.
- `pnpm lint` — clean.

## Self-Review notes (author)

- **Spec coverage:** clients CRUD (T2), lawful_basis as fact (T1 column), withdrawable consents separate from basis (T4), append-only audit (T3), operative export+erasure with per-table policy (T5), coverage forcing-test (T6), per-table RLS + isolation tests (T1/T3/T4), invoice retention deferred as documented slot (T5 policy comment). All §-items mapped.
- **Type consistency:** service signatures `(userId, …)`; `recordAudit(tx, args)` takes the live tx; `ConsentScope` reused across consents.ts; `ClientExport` shape matches the gdpr test.
- **Known deviation logged:** `audit_log` erasure uses the owner connection — the single sanctioned request-path owner write, documented in Global Constraints and T5.
