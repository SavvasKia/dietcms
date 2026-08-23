# Task 2 brief: client-service CRUD + soft-delete

Module: client-records+GDPR. Branch: `feat/client-records` (already checked out, clean at `81f9382`).
Plan: `docs/superpowers/plans/2026-06-28-client-records-gdpr.md` § "Task 2" (lines 227–405). **Read it — it contains the full implementation and test code. This brief adds constraints on top of it, it does not replace it.**

## Scope

- Create: `lib/clients.ts`
- Modify: `tests/integration/clients-rls.test.ts` (append a `client-service` describe)
- **No migration in this task.** If you find yourself running `pnpm db:generate`, stop — you have gone out of scope.

Exports required (exact signatures from the plan):
`NewClient`, `createClient`, `getClient`, `listClients`, `updateClient`, `softDeleteClient`.

## Load-bearing facts — do not rabbit-hole on these

1. **`withUser` signature is `withUser<T>(userId: string, fn: (tx: typeof authedDb) => Promise<T>)`** (`db/authed-client.ts:17`). The plan's brief writes the helper param as `typeof import('@/db/authed-client').authedDb`. Prefer `import { authedDb, withUser } from '@/db/authed-client'` and type the helper `tx: typeof authedDb` — same type, readable. Importing `authedDb` creates no extra pool; the module already builds one on import.
2. **NEVER nest `withUser` / `authedDb.transaction()` inside a `withUser` callback.** A nested call takes a fresh pooled connection *without* the `app.user_id` GUC, so RLS silently sees an empty user and returns nothing — fail-closed but wrong, and it will not throw. Documented at `db/authed-client.ts:19-23`. Concretely: `callerTenantId` must take the live `tx`, never call `withUser` itself. This bites again in Task 3 when audit writes are added, so get it right here.
3. **Services never accept `tenantId` from the caller.** `createClient` resolves it inside the transaction by selecting from `tenant_members` — RLS returns only the caller's own row. No membership → throw (fail-closed).
4. **`authenticated_backend` already has CRUD on new tables** via foundation's `ALTER DEFAULT PRIVILEGES`. A `permission denied for table clients` means that grant path missed this table — it is NOT an RLS model bug. Do not redesign RLS.
5. **`clients` policy is `FOR ALL`**, so UPDATE and the soft-delete UPDATE are covered by the same tenant predicate. No extra policy needed.
6. **Integration tests seed via the owner connection (`db` from `db/client.ts`)** and assert via `withUser`. `neondb_owner` has BYPASSRLS, which is why owner seeding works despite FORCE RLS on `clients`. Keep that split.
7. `pnpm test:int` needs `.env.local` (present). `DATABASE_URL_AUTHENTICATED` is the unprivileged role; `DATABASE_URL` is owner.

## Test requirements — stricter than the plan

The plan's `client-service` describe is the floor, not the ceiling. Task 1's review caught two assertions that passed for the wrong reason; do not reintroduce that class of defect.

**Mandatory additions:**

1. **Guard every cross-test id.** The plan's describe assigns `createdId` in test 1 and consumes it in tests 2–4. Add `expect(createdId).toBeTruthy()` at the top of each consuming test, or move the create into `beforeAll`. Rationale: a `not.toContain(undefined)` or a `getClient(userS, undefined)` assertion goes green precisely when setup broke.
2. **Assert on real error text, never a bare `toThrow()`.** `tests/integration/clients-rls.test.ts` now has an `errorChain()` helper at the top — **reuse it**. Drizzle wraps pg errors as `Failed query: …` and puts the real one in `.cause`, so a bare `.rejects.toThrow()` also passes on permission-denied, a NOT NULL violation, or a network blip.
3. **Service-level cross-tenant denial (the security assertion the plan omits).** Seed a second user/tenant, have them create a client, then assert from the first user:
   - `getClient(userOther, clientIdOfS)` → `null`
   - `listClients(userOther)` does not contain `clientIdOfS`
   - `updateClient(userOther, clientIdOfS, { goals: 'x' })` → `null` (RLS filters the row; no rows updated)
   - `softDeleteClient(userOther, clientIdOfS)` → `false`, **and** the row is still visible to `userS` afterwards (prove the failed delete did not land)
4. **`getClient` with a random UUID** → `null` (not a throw).
5. **`softDeleteClient` is not idempotent-true:** a second call on the same id → `false` (the `isNull(deletedAt)` predicate already excludes it).
6. **`updateClient` bumps `updatedAt`.** Capture `createdAt`/`updatedAt` from create, then assert the patched row's `updatedAt` is strictly greater. There is no DB trigger — the service is the only thing setting it, so this is the only proof it happens.
7. **`updateClient` on a soft-deleted client** → `null`.

## TDD discipline

RED first: write the tests, run `pnpm test:int -- clients-rls`, and **paste the actual failure output** in your report. Then implement, then GREEN. A report without real RED output is not accepted.

## Verification before you report

All four must be run and their output pasted:
- `pnpm test:int -- clients-rls` — green
- `pnpm test` — green (21/21 currently)
- `pnpm typecheck` — clean
- `pnpm lint` — clean

Known possible friction: `listClients` in the plan returns the drizzle query builder directly (`(tx) => tx.select()…`) rather than an `async` fn. Drizzle's `QueryPromise` satisfies `Promise<T>`, so this should typecheck; if it does not, make the callback `async` and `await` — do not change the exported signature.

## Commit

Conventional Commits, subject ≤50 chars. Body only where the "why" isn't obvious from the diff.
```
git add lib/clients.ts tests/integration/clients-rls.test.ts
```
Co-author trailer: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## Report

Write `.superpowers/sdd/client-records/task-2-report.md`: what you implemented, RED/GREEN evidence (real output), files changed, self-review, and **concerns** — anything you assumed, worked around, or think is wrong in the plan. Say so plainly; a report claiming "no concerns" on a task with 7 added test requirements will be read as under-inspected.

## Out of scope — leave for later tasks

- Audit logging (Task 3). Do not add audit calls or an `audit_log` table.
- Consents (Task 4), GDPR export/erase (Task 5), coverage tripwire (Task 6).
- Any index on `tenant_id`. No table in this repo has one; the convention gets decided at Task 3/4, not here.
- UI / route handlers. This task is service layer only.
