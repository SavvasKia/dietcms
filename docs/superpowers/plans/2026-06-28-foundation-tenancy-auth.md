# Foundation: Tenancy, Auth & Observability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the multi-tenant Next.js + Neon foundation where an authenticated dietitian gets a database-isolated tenant, proven by Row-Level-Security tests, with Sentry/PostHog wired up so they never receive health data.

**Architecture:** Next.js App Router on Vercel (EU region) talks to Neon Postgres (EU) through Drizzle. Neon Auth (Stack Auth) authenticates users and issues a JWT; Postgres RLS policies read that JWT so the database — not app code — enforces tenant isolation. Every tenant-owned table carries `tenant_id` and an RLS policy. Sentry and PostHog are configured to scrub/mask all personal and health data.

**Tech Stack:** Next.js (App Router) + React + TypeScript + Tailwind; Neon serverless Postgres; Drizzle ORM + drizzle-kit; Neon Auth (`@stackframe/stack`); Sentry (`@sentry/nextjs`); PostHog (`posthog-js` EU Cloud); Vitest + React Testing Library; Playwright.

## Global Constraints

- **EU region only.** Neon project, Vercel functions, Sentry data region, PostHog host (`https://eu.i.posthog.com`) must all be EU. A US default is a GDPR violation for health data.
- **No special-category data to third parties.** Sentry `beforeSend` scrubs PII; request bodies disabled. PostHog autocapture masks all inputs; no client/patient attributes in events.
- **Tenant isolation is enforced at the DB layer (RLS).** App-code filtering by `tenant_id` is defense-in-depth, never the only line.
- **TDD.** Every behavioral change starts with a failing test. Frequent commits.
- **Language:** UI copy in Greek with English fallback; code, identifiers, and comments in English.
- **Node:** use the version pinned in `.nvmrc` (Node 20 LTS). Package manager: `pnpm`.

> **Execution note — fast-moving APIs:** Neon Auth (Stack Auth) and Drizzle's RLS helpers have changed since this plan's knowledge cutoff (Jan 2026). Task 5 begins with a doc-verification step. If a documented signature differs from the code shown here, follow the current docs and keep the *behavior* (JWT claim → RLS policy) identical.

---

### Task 1: Project scaffold + test harness

**Files:**
- Create: `package.json`, `pnpm-lock.yaml`, `.nvmrc`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`
- Create: `vitest.config.ts`, `vitest.setup.ts`, `playwright.config.ts`, `tests/unit/smoke.test.ts`, `e2e/smoke.spec.ts`
- Create: `.gitignore`, `.env.example`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a runnable Next.js app (`pnpm dev`), `pnpm test` (Vitest), `pnpm test:e2e` (Playwright), `pnpm lint`, `pnpm typecheck`.

- [ ] **Step 1: Scaffold Next.js app**

Run:
```bash
pnpm dlx create-next-app@latest . --ts --tailwind --app --eslint --src-dir=false --import-alias "@/*" --use-pnpm --no-turbopack
echo "20" > .nvmrc
```
Expected: project files created; `pnpm dev` serves the default page on :3000.

- [ ] **Step 2: Add test tooling**

Run:
```bash
pnpm add -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @playwright/test
pnpm exec playwright install --with-deps chromium
```

- [ ] **Step 3: Write Vitest config + setup**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    globals: true,
  },
  resolve: { alias: { '@': resolve(__dirname, '.') } },
})
```

`vitest.setup.ts`:
```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 4: Write the failing unit smoke test**

`tests/unit/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest'

describe('toolchain', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2)
  })
})
```

Run: `pnpm exec vitest run tests/unit/smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Write Playwright config + smoke E2E**

`playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
})
```

`e2e/smoke.spec.ts`:
```ts
import { test, expect } from '@playwright/test'

test('home page renders', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('body')).toBeVisible()
})
```

- [ ] **Step 6: Add scripts to package.json**

Add under `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest",
"test:e2e": "playwright test",
"typecheck": "tsc --noEmit",
"lint": "next lint"
```

- [ ] **Step 7: Run the full toolchain**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
```
Expected: typecheck clean, lint clean, 1 unit test PASS, 1 E2E PASS.

- [ ] **Step 8: Write `.env.example`**

```bash
# Neon
DATABASE_URL=
DATABASE_URL_AUTHENTICATED=
# Neon Auth (Stack Auth)
NEXT_PUBLIC_STACK_PROJECT_ID=
NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY=
STACK_SECRET_SERVER_KEY=
# Sentry
NEXT_PUBLIC_SENTRY_DSN=
SENTRY_AUTH_TOKEN=
# PostHog (EU)
NEXT_PUBLIC_POSTHOG_KEY=
NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with Vitest and Playwright harness"
```

---

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

### Task 3: Neon Auth (Stack Auth) integration

**Files:**
- Create: `stack.ts`, `app/handler/[...stack]/page.tsx`, `app/loading.tsx`
- Modify: `app/layout.tsx` (wrap with `StackProvider`/`StackTheme`)
- Create: `tests/unit/auth-helpers.test.ts`, `lib/auth.ts`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_STACK_PROJECT_ID`, `NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY`, `STACK_SECRET_SERVER_KEY`.
- Produces:
  - `stackServerApp` — server-side Stack app instance.
  - `getCurrentUser(): Promise<{ id: string; email: string } | null>` in `lib/auth.ts` — returns the authenticated user or null.

- [ ] **Step 1: Enable Neon Auth + verify current setup docs**

Manual: in the Neon console enable **Neon Auth** for the project; copy the three Stack keys into `.env.local`. Open the current Neon Auth + Next.js quickstart and confirm the package name and provider component names below are still current; adjust if changed (Execution note at top).

- [ ] **Step 2: Install Stack Auth**

Run: `pnpm add @stackframe/stack`

- [ ] **Step 3: Create the Stack server app**

`stack.ts`:
```ts
import 'server-only'
import { StackServerApp } from '@stackframe/stack'

export const stackServerApp = new StackServerApp({
  tokenStore: 'nextjs-cookie',
})
```

- [ ] **Step 4: Wire the auth handler route + provider**

`app/handler/[...stack]/page.tsx`:
```tsx
import { StackHandler } from '@stackframe/stack'
import { stackServerApp } from '@/stack'

export default function Handler(props: unknown) {
  return <StackHandler fullPage app={stackServerApp} routeProps={props} />
}
```

Modify `app/layout.tsx` to wrap children:
```tsx
import { StackProvider, StackTheme } from '@stackframe/stack'
import { stackServerApp } from '@/stack'
// inside <body>:
// <StackProvider app={stackServerApp}><StackTheme>{children}</StackTheme></StackProvider>
```

- [ ] **Step 5: Write the failing auth-helper test**

`tests/unit/auth-helpers.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/stack', () => ({
  stackServerApp: { getUser: vi.fn() },
}))

import { stackServerApp } from '@/stack'
import { getCurrentUser } from '@/lib/auth'

describe('getCurrentUser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null when no user', async () => {
    ;(stackServerApp.getUser as any).mockResolvedValue(null)
    expect(await getCurrentUser()).toBeNull()
  })

  it('maps id and primaryEmail', async () => {
    ;(stackServerApp.getUser as any).mockResolvedValue({ id: 'u1', primaryEmail: 'a@b.gr' })
    expect(await getCurrentUser()).toEqual({ id: 'u1', email: 'a@b.gr' })
  })
})
```

Run: `pnpm exec vitest run tests/unit/auth-helpers.test.ts`
Expected: FAIL — `@/lib/auth` not found.

- [ ] **Step 6: Implement the auth helper**

`lib/auth.ts`:
```ts
import { stackServerApp } from '@/stack'

export async function getCurrentUser(): Promise<{ id: string; email: string } | null> {
  const user = await stackServerApp.getUser()
  if (!user) return null
  return { id: user.id, email: user.primaryEmail ?? '' }
}
```

- [ ] **Step 7: Run auth-helper test to verify pass**

Run: `pnpm exec vitest run tests/unit/auth-helpers.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: integrate Neon Auth (Stack Auth) with getCurrentUser helper"
```

---

### Task 4: Tenant bootstrap on first login

**Files:**
- Create: `lib/tenant.ts`, `tests/unit/tenant-bootstrap.test.ts`
- Create: `app/(app)/dashboard/page.tsx`, `middleware.ts`

**Interfaces:**
- Consumes: `getCurrentUser` (Task 3), `db`, `tenants`, `tenantMembers` (Task 2).
- Produces:
  - `ensureTenantForUser(userId: string, displayName: string): Promise<string>` — returns the user's `tenantId`, creating a tenant + `tenant_members` row on first call, idempotent on later calls.
  - `getTenantIdForUser(userId: string): Promise<string | null>`.

- [ ] **Step 1: Write the failing bootstrap test**

`tests/unit/tenant-bootstrap.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows: any[] = []
vi.mock('@/db/client', () => ({
  db: {
    // minimal fake: membership lookup + inserts
    _members: rows,
  },
}))

// We test the pure decision function instead of the DB plumbing:
import { decideBootstrap } from '@/lib/tenant'

describe('decideBootstrap', () => {
  it('creates when no membership exists', () => {
    expect(decideBootstrap(null)).toEqual({ action: 'create' })
  })
  it('reuses existing tenant', () => {
    expect(decideBootstrap('t-1')).toEqual({ action: 'reuse', tenantId: 't-1' })
  })
})
```

Run: `pnpm exec vitest run tests/unit/tenant-bootstrap.test.ts`
Expected: FAIL — `decideBootstrap` not exported.

- [ ] **Step 2: Implement tenant logic (pure decision + DB wrapper)**

`lib/tenant.ts`:
```ts
import { eq, and } from 'drizzle-orm'
import { db } from '@/db/client'
import { tenants, tenantMembers } from '@/db/schema'

export function decideBootstrap(
  existingTenantId: string | null,
): { action: 'create' } | { action: 'reuse'; tenantId: string } {
  return existingTenantId
    ? { action: 'reuse', tenantId: existingTenantId }
    : { action: 'create' }
}

export async function getTenantIdForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ tenantId: tenantMembers.tenantId })
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, userId))
    .limit(1)
  return row?.tenantId ?? null
}

export async function ensureTenantForUser(userId: string, displayName: string): Promise<string> {
  const existing = await getTenantIdForUser(userId)
  const decision = decideBootstrap(existing)
  if (decision.action === 'reuse') return decision.tenantId

  const [tenant] = await db.insert(tenants).values({ name: displayName }).returning({ id: tenants.id })
  await db.insert(tenantMembers).values({ userId, tenantId: tenant.id, role: 'owner' })
  return tenant.id
}
```

- [ ] **Step 3: Run bootstrap test to verify pass**

Run: `pnpm exec vitest run tests/unit/tenant-bootstrap.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Protect app routes + bootstrap on dashboard**

`middleware.ts` (redirect unauthenticated users away from `(app)` routes):
```ts
import { NextResponse, type NextRequest } from 'next/server'
import { stackServerApp } from '@/stack'

export async function middleware(req: NextRequest) {
  const user = await stackServerApp.getUser()
  if (!user) return NextResponse.redirect(new URL('/handler/sign-in', req.url))
  return NextResponse.next()
}

export const config = { matcher: ['/dashboard/:path*'] }
```

`app/(app)/dashboard/page.tsx`:
```tsx
import { getCurrentUser } from '@/lib/auth'
import { ensureTenantForUser } from '@/lib/tenant'

export default async function Dashboard() {
  const user = await getCurrentUser()
  if (!user) return null
  const tenantId = await ensureTenantForUser(user.id, user.email)
  return <main className="p-8">Practice ready. Tenant: {tenantId}</main>
}
```

- [ ] **Step 5: Manual verify + commit**

Run `pnpm dev`, sign up via `/handler/sign-up`, land on `/dashboard`, confirm a `tenants` row + `tenant_members` row exist in Neon.
```bash
git add -A
git commit -m "feat: bootstrap a tenant for each user on first login"
```

---

### Task 5: Row-Level Security driven by the auth JWT  ← the spike

**Files:**
- Create: `db/rls.sql`, `db/authed-client.ts`, `tests/integration/rls-isolation.test.ts`
- Modify: `db/schema.ts` (add `tenant_id` + enable RLS on a probe table)
- Create: `vitest.integration.config.ts`

**Interfaces:**
- Consumes: Neon authenticated connection string `DATABASE_URL_AUTHENTICATED`, the Stack Auth JWT.
- Produces:
  - `authedDb(jwt: string)` — a Drizzle client whose connection carries the JWT so RLS policies see `auth.user_id()`.
  - A `notes` probe table (`id`, `tenant_id`, `body`) with RLS proving isolation. (Probe table is removed/replaced when the real domain tables arrive in later plans; it exists to validate the mechanism.)

- [ ] **Step 1: Verify current Neon RLS + Drizzle helpers against docs**

Manual: open Neon's "RLS with Neon Auth" guide and Drizzle's `pgPolicy`/`crudPolicy` docs. Confirm: (a) the authenticated role name, (b) how the JWT is passed (Neon serverless driver `authToken`), (c) the SQL function exposing the user id (`auth.user_id()`). Adjust Steps below to match current names; keep behavior identical.

- [ ] **Step 2: Add tenant_id + RLS-enabled probe table to schema**

Append to `db/schema.ts`:
```ts
import { pgPolicy } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

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
      to: 'authenticated',
      using: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = auth.user_id() limit 1)`,
      withCheck: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = auth.user_id() limit 1)`,
    }),
  ],
).enableRLS()
```

- [ ] **Step 3: Generate + apply migration; grant authenticated role**

`db/rls.sql` (run once in Neon SQL editor if the grant is not auto-managed):
```sql
grant select, insert, update, delete on notes to authenticated;
```
Run:
```bash
pnpm db:generate
pnpm db:migrate
```
Expected: `notes` table created with RLS enabled.

- [ ] **Step 4: Write the authenticated client**

`db/authed-client.ts`:
```ts
import { drizzle } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import * as schema from './schema'

// Returns a Drizzle client whose every query carries the user's JWT,
// so Postgres RLS evaluates auth.user_id() for that user.
export function authedDb(jwt: string) {
  const sql = neon(process.env.DATABASE_URL_AUTHENTICATED!, { authToken: jwt })
  return drizzle(sql, { schema })
}
```

- [ ] **Step 5: Write the failing RLS isolation test**

`vitest.integration.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
export default defineConfig({
  test: { include: ['tests/integration/**/*.test.ts'], environment: 'node', testTimeout: 30000 },
  resolve: { alias: { '@': resolve(__dirname, '.') } },
})
```

`tests/integration/rls-isolation.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { authedDb } from '@/db/authed-client'
import { notes } from '@/db/schema'

// Requires two real Stack Auth test-user JWTs in env, each bootstrapped to a
// distinct tenant: TEST_JWT_A (tenant A), TEST_JWT_B (tenant B).
const jwtA = process.env.TEST_JWT_A!
const jwtB = process.env.TEST_JWT_B!

describe('RLS tenant isolation', () => {
  let insertedId: string
  beforeAll(async () => {
    const dbA = authedDb(jwtA)
    const [row] = await dbA
      .insert(notes)
      .values({ tenantId: (await tenantOf(jwtA)), body: 'A-secret' })
      .returning({ id: notes.id })
    insertedId = row.id
  })

  it('owner (A) can read its row', async () => {
    const rows = await authedDb(jwtA).select().from(notes)
    expect(rows.some((r) => r.id === insertedId)).toBe(true)
  })

  it('other tenant (B) cannot read A row', async () => {
    const rows = await authedDb(jwtB).select().from(notes)
    expect(rows.some((r) => r.id === insertedId)).toBe(false)
  })

  it('B cannot insert into A tenant (withCheck blocks it)', async () => {
    await expect(
      authedDb(jwtB).insert(notes).values({ tenantId: await tenantOf(jwtA), body: 'evil' }),
    ).rejects.toThrow()
  })
})

// helper: read the caller's own tenant via the authed connection
async function tenantOf(jwt: string): Promise<string> {
  const db = authedDb(jwt)
  const r: any = await db.execute(
    'select tenant_id from tenant_members where user_id = auth.user_id() limit 1' as any,
  )
  return r.rows?.[0]?.tenant_id ?? r[0]?.tenant_id
}
```

Add script: `"test:int": "vitest run --config vitest.integration.config.ts"`.

Run: `pnpm test:int`
Expected: FAIL initially (table/policy/JWTs not all in place).

- [ ] **Step 6: Make the isolation test pass**

Create two Stack Auth test users, sign each in once against the running app to trigger tenant bootstrap, capture their JWTs into `.env.local` as `TEST_JWT_A`/`TEST_JWT_B` (document this in `README` testing section). Re-run:

Run: `pnpm test:int`
Expected: PASS (3 tests) — A reads its row, B cannot read it, B cannot insert into A's tenant.

> **Gate:** This is the architectural spike. If these three assertions pass, the Neon Auth → RLS foundation is proven and every later module table can follow the `notes` policy pattern. If they cannot be made to pass, STOP and escalate — the multi-tenancy approach needs rework before proceeding.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: enforce tenant isolation via Postgres RLS driven by auth JWT"
```

---

### Task 6: Sentry with PII scrubbing + privacy regression test

**Files:**
- Create: `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation.ts`
- Create: `lib/scrub.ts`, `tests/unit/scrub.test.ts`
- Modify: `next.config.ts` (wrap with `withSentryConfig`)

**Interfaces:**
- Consumes: `NEXT_PUBLIC_SENTRY_DSN`.
- Produces: `scrubEvent(event)` — strips request bodies, cookies, and any key matching the PII/health denylist; used as Sentry `beforeSend`.

- [ ] **Step 1: Install Sentry**

Run: `pnpm add @sentry/nextjs`

- [ ] **Step 2: Write the failing scrub test**

`tests/unit/scrub.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { scrubEvent } from '@/lib/scrub'

describe('scrubEvent', () => {
  it('removes request body and cookies', () => {
    const out = scrubEvent({ request: { data: { afm: '123' }, cookies: { s: 'x' }, headers: { a: 'b' } } } as any)
    expect(out.request?.data).toBeUndefined()
    expect(out.request?.cookies).toBeUndefined()
  })
  it('redacts denylisted keys anywhere in extra', () => {
    const out = scrubEvent({ extra: { clientName: 'Maria', weight: 70, note: 'ok' } } as any)
    expect(out.extra?.clientName).toBe('[redacted]')
    expect(out.extra?.weight).toBe('[redacted]')
    expect(out.extra?.note).toBe('ok')
  })
})
```

Run: `pnpm exec vitest run tests/unit/scrub.test.ts`
Expected: FAIL — `@/lib/scrub` not found.

- [ ] **Step 3: Implement the scrubber**

`lib/scrub.ts`:
```ts
import type { ErrorEvent } from '@sentry/nextjs'

const DENY = /(name|email|phone|afm|dob|birth|address|weight|height|bmi|body|medical|allergy|diagnos|note|client|patient)/i

function redact<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj
  for (const k of Object.keys(obj as Record<string, unknown>)) {
    if (DENY.test(k)) (obj as Record<string, unknown>)[k] = '[redacted]'
    else redact((obj as Record<string, unknown>)[k])
  }
  return obj
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.data
    delete event.request.cookies
    delete event.request.headers
  }
  if (event.extra) redact(event.extra)
  if (event.contexts) redact(event.contexts)
  return event
}
```

- [ ] **Step 4: Run scrub test to verify pass**

Run: `pnpm exec vitest run tests/unit/scrub.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire Sentry configs (EU region, scrubber, no PII)**

`sentry.client.config.ts` / `sentry.server.config.ts` / `sentry.edge.config.ts` each:
```ts
import * as Sentry from '@sentry/nextjs'
import { scrubEvent } from '@/lib/scrub'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  beforeSend: scrubEvent,
})
```
`instrumentation.ts`:
```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./sentry.server.config')
  if (process.env.NEXT_RUNTIME === 'edge') await import('./sentry.edge.config')
}
```
Wrap `next.config.ts` export with `withSentryConfig(nextConfig, { silent: true })`. Confirm the Sentry **project data region is EU** in the Sentry dashboard (Global Constraint).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Sentry with PII/health scrubbing and regression test"
```

---

### Task 7: PostHog (EU Cloud, input-masked) + analytics guard

**Files:**
- Create: `app/providers.tsx`, `lib/analytics.ts`, `tests/unit/analytics.test.ts`
- Modify: `app/layout.tsx` (mount providers)

**Interfaces:**
- Consumes: `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`.
- Produces: `capture(event: string, props?: Record<string, string | number | boolean>)` — wrapper that throws in tests if a denylisted key is passed, preventing health data in events.

- [ ] **Step 1: Install PostHog**

Run: `pnpm add posthog-js`

- [ ] **Step 2: Write the failing analytics-guard test**

`tests/unit/analytics.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { assertSafeProps } from '@/lib/analytics'

describe('assertSafeProps', () => {
  it('allows non-identifying props', () => {
    expect(() => assertSafeProps({ plan: 'pro', step: 2 })).not.toThrow()
  })
  it('rejects identifying/health props', () => {
    expect(() => assertSafeProps({ clientName: 'Maria' })).toThrow()
    expect(() => assertSafeProps({ weight: 70 })).toThrow()
  })
})
```

Run: `pnpm exec vitest run tests/unit/analytics.test.ts`
Expected: FAIL — `@/lib/analytics` not found.

- [ ] **Step 3: Implement the analytics guard + capture**

`lib/analytics.ts`:
```ts
import posthog from 'posthog-js'

const DENY = /(name|email|phone|afm|dob|birth|address|weight|height|bmi|body|medical|allergy|diagnos|note|client|patient)/i

export function assertSafeProps(props: Record<string, unknown>): void {
  for (const k of Object.keys(props)) {
    if (DENY.test(k)) throw new Error(`analytics: denylisted prop "${k}" — never send personal/health data`)
  }
}

export function capture(event: string, props: Record<string, string | number | boolean> = {}): void {
  assertSafeProps(props)
  posthog.capture(event, props)
}
```

- [ ] **Step 4: Run analytics test to verify pass**

Run: `pnpm exec vitest run tests/unit/analytics.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount PostHog provider (EU host, full input masking)**

`app/providers.tsx`:
```tsx
'use client'
import posthog from 'posthog-js'
import { PostHogProvider } from 'posthog-js/react'
import { useEffect } from 'react'

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST, // https://eu.i.posthog.com
      autocapture: { dom_event_allowlist: ['click'] },
      mask_all_text: true,
      mask_all_element_attributes: true,
      session_recording: { maskAllInputs: true, maskTextSelector: '*' },
      person_profiles: 'identified_only',
    })
  }, [])
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>
}
```
Mount `<Providers>` in `app/layout.tsx` inside the Stack provider.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add PostHog (EU, input-masked) with analytics safety guard"
```

---

### Task 8: Deploy to Vercel (EU region) + CI gate

**Files:**
- Create: `.github/workflows/ci.yml`, `vercel.json`
- Modify: `README.md` (setup + testing + env docs)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a deployed EU-region app; CI running typecheck + lint + unit + E2E on every PR.

- [ ] **Step 1: Pin Vercel functions to EU**

`vercel.json`:
```json
{ "regions": ["fra1"] }
```

- [ ] **Step 2: Write CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm test:e2e
```
(Integration RLS tests run separately — they need live Neon + JWTs; document as a manual/secrets-gated job.)

- [ ] **Step 3: Connect Vercel + set EU env**

Manual: import the repo in Vercel, set all env vars (EU values), confirm the project region is `fra1`. Deploy.

- [ ] **Step 4: Verify the live smoke flow**

Run the Playwright smoke against the preview URL; manually sign up on the deployed app and confirm dashboard + tenant creation against Neon.

- [ ] **Step 5: Write README setup/testing/env section + commit**

Document: env vars, how to get the two test JWTs for RLS tests, EU-region requirement, the three test commands.
```bash
git add -A
git commit -m "ci: add EU-region Vercel deploy and CI pipeline"
```

---

## Self-Review

**Spec coverage (against §5 architecture + §5.4/§5.5 + §9):**
- Multi-tenant + RLS → Tasks 2, 4, 5 ✓
- Next.js + Vercel EU → Tasks 1, 8 ✓
- Neon + Drizzle → Task 2 ✓
- Neon Auth → Task 3 ✓
- Sentry (scrubbed) → Task 6 ✓
- PostHog (EU, masked) → Task 7 ✓
- Vitest + RTL → Task 1 ✓; Playwright → Tasks 1, 8 ✓
- RLS isolation test → Task 5 ✓; privacy regression → Tasks 6, 7 ✓
- **Not in this plan (correct — later module plans):** client records/GDPR consent, food DB, meal-plan builder, anthropometrics, scheduling, billing/myDATA. This plan is the foundation only.

**Placeholder scan:** No TBD/TODO; every code step has concrete code. The `notes` probe table is intentionally temporary and labeled as such.

**Type consistency:** `getCurrentUser` returns `{id,email}` (Task 3) and is consumed in Task 4 ✓. `ensureTenantForUser(userId, displayName)` defined Task 4, used in dashboard ✓. `authedDb(jwt)` defined Task 5 and used in tests ✓. `scrubEvent`/`assertSafeProps`/`capture` consistent across Tasks 6–7 ✓.

**Known execution risk:** exact Neon Auth + Drizzle RLS API names may have moved since Jan 2026; Task 5 Step 1 + Task 3 Step 1 mandate doc verification. This is the gated spike.
