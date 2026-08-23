### Task 2: Neon database + Drizzle wiring

**Files:**
- Create: `db/client.ts`, `db/schema.ts`, `drizzle.config.ts`
- Create: `tests/unit/db-schema.test.ts`
- Modify: `package.json` (db scripts)

**Interfaces:**
- Consumes: `DATABASE_URL` from env.
- Produces:
  - `db` — Drizzle client bound to the admin connection (migrations/seeding).
  - `tenants` table: `{ id: uuid pk, name: text, afm: text, address: text, subscriptionState: text default 'trial', createdAt: timestamptz }`.
  - `tenantMembers` table: `{ userId: text, tenantId: uuid fk→tenants.id, role: text }`, pk `(userId, tenantId)`.

- [ ] **Step 1: Provision Neon (EU) and set env**

Manual: create a Neon project in an **EU region** (e.g. `eu-central-1`). Copy the pooled connection string into `.env.local` as `DATABASE_URL`. (Confirm region in the Neon console — Global Constraint.)

- [ ] **Step 2: Install Drizzle + Neon driver**

Run:
```bash
pnpm add drizzle-orm @neondatabase/serverless
pnpm add -D drizzle-kit dotenv
```

- [ ] **Step 3: Write the failing schema test**

`tests/unit/db-schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { tenants, tenantMembers } from '@/db/schema'
import { getTableConfig } from 'drizzle-orm/pg-core'

describe('schema', () => {
  it('tenants has tenant identity columns', () => {
    const cols = getTableConfig(tenants).columns.map((c) => c.name)
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'name', 'afm', 'address', 'subscription_state', 'created_at']),
    )
  })
  it('tenant_members maps user to tenant with role', () => {
    const cols = getTableConfig(tenantMembers).columns.map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['user_id', 'tenant_id', 'role']))
  })
})
```

Run: `pnpm exec vitest run tests/unit/db-schema.test.ts`
Expected: FAIL — `@/db/schema` not found.

- [ ] **Step 4: Write the schema**

`db/schema.ts`:
```ts
import { pgTable, uuid, text, timestamp, primaryKey } from 'drizzle-orm/pg-core'

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  afm: text('afm'),
  address: text('address'),
  subscriptionState: text('subscription_state').notNull().default('trial'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const tenantMembers = pgTable(
  'tenant_members',
  {
    userId: text('user_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('owner'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.tenantId] }) }),
)
```

- [ ] **Step 5: Run schema test to verify it passes**

Run: `pnpm exec vitest run tests/unit/db-schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Write the Drizzle client + config**

`db/client.ts`:
```ts
import { drizzle } from 'drizzle-orm/neon-serverless'
import { Pool } from '@neondatabase/serverless'
import * as schema from './schema'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
export const db = drizzle(pool, { schema })
```

`drizzle.config.ts`:
```ts
import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

- [ ] **Step 7: Generate and apply the migration**

Add to `package.json` scripts: `"db:generate": "drizzle-kit generate"`, `"db:migrate": "drizzle-kit migrate"`.
Run:
```bash
pnpm db:generate
pnpm db:migrate
```
Expected: migration file created in `db/migrations/`; `tenants` and `tenant_members` exist in Neon (verify in Neon SQL editor: `\d tenants`).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add Neon + Drizzle with tenants and tenant_members schema"
```

---

