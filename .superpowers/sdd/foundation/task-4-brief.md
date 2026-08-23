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

