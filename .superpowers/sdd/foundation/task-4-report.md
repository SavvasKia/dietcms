# Task 4 Report: Tenant Bootstrap on First Login

## What Was Built

- **`lib/tenant.ts`**: Three exports:
  - `decideBootstrap(existingTenantId)` — pure function, returns `{action:'create'}` or `{action:'reuse', tenantId}`.
  - `getTenantIdForUser(userId)` — Drizzle query on `tenant_members`, returns `string | null`.
  - `ensureTenantForUser(userId, displayName)` — idempotent: reuses existing tenant or inserts into `tenants` + `tenant_members`.

- **`tests/unit/tenant-bootstrap.test.ts`**: Unit test for `decideBootstrap` using `vi.mock('@/db/client')`.

- **`app/(app)/dashboard/page.tsx`**: Async server component that calls `getCurrentUser()` + `ensureTenantForUser()`, renders tenant ID.

- **`middleware.ts`**: Checks `stackServerApp.getUser()`, redirects unauthenticated to `/handler/sign-in`. Matcher: `['/dashboard/:path*']`.

## TDD RED/GREEN Evidence

**RED**: `pnpm exec vitest run tests/unit/tenant-bootstrap.test.ts` → `FAIL` — `Failed to resolve import "@/lib/tenant"` (file did not exist yet).

**Fix note**: The brief's `vi.mock` factory referenced `const rows = []` which is hoisted above the variable declaration, causing `ReferenceError: Cannot access 'rows' before initialization`. Fixed by inlining the empty array directly in the factory (equivalent semantics, no `rows` variable needed).

**GREEN**: After implementing `lib/tenant.ts` and fixing the mock → `Tests 2 passed (2)`.

**Full suite**: `pnpm test` → `4 test files, 7 tests, all passed`.

## Deferred Pending Keys

Runtime verification (sign-up flow via `/handler/sign-up`, dashboard render, Neon row verification) is **DEFERRED** — the two Stack Auth environment keys (`NEXT_PUBLIC_STACK_PROJECT_ID`, `STACK_SECRET_SERVER_KEY`) are not configured, so `stackServerApp` cannot authenticate and `pnpm dev` cannot load protected routes.

## Files Changed

- `lib/tenant.ts` (new)
- `tests/unit/tenant-bootstrap.test.ts` (new, brief code + mock hoisting fix)
- `app/(app)/dashboard/page.tsx` (new)
- `middleware.ts` (new)

## Concerns

- **Mock hoisting fix**: The brief's test template had a hoisting bug (`const rows` used inside hoisted `vi.mock` factory). Fixed by inlining `[]` directly. Semantics are identical; the `rows` variable was never actually used inside the factory body (only `_members: rows` which is a snapshot copy anyway).
- No concerns with the DB logic — it matches the brief exactly.
