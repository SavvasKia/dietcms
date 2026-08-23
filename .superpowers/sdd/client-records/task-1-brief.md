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
    allergies: text('allergies').array().notNull().default(sql`'{}'::text[]`),
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

