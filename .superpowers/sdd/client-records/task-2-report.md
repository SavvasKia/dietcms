# Task 2 report: client-service CRUD + soft-delete

Branch `feat/client-records`, base `81f9382`.

## What I implemented

**Created `lib/clients.ts`** — service layer only, exactly the plan's exports/signatures:
`NewClient`, `createClient`, `getClient`, `listClients`, `updateClient`, `softDeleteClient`.

- `callerTenantId(tx)` takes the **live `tx`** and selects from `tenant_members` with **no
  `where`** — RLS returns only the caller's row. No membership -> `throw new Error('no tenant
  for user')` (fail-closed). It never calls `withUser`/`authedDb.transaction()` itself, per the
  nested-transaction warning at `db/authed-client.ts:18-23`.
- Callers never pass `tenantId`; `createClient` resolves it inside the transaction.
- `getClient` / `listClients` / `updateClient` / `softDeleteClient` all carry `isNull(deletedAt)`.
- `updateClient` sets `updatedAt: new Date()` **after** the patch spread; returns `null` when
  zero rows come back (unknown id, other tenant, or already soft-deleted).
- `softDeleteClient` returns `rows.length > 0`, so a second call on the same id is `false`.
- Typed the helper `tx: typeof authedDb` per the brief. Importing `authedDb` adds no pool —
  `db/authed-client.ts` builds it at module load either way.
- No migration generated, no schema change, no audit/consent/GDPR/index/UI code.

**Extended `tests/integration/clients-rls.test.ts`** with a `client-service` describe (10 tests).
Seeding stays on the owner connection (`db`), assertions go through the service (which uses
`withUser`). Reused the existing `errorChain()` helper.

## Mandatory test requirements — where each one lives

| # | Requirement | Test |
|---|---|---|
| 1 | Guard every cross-test id | **Satisfied structurally**: there is no cross-test id. Each test that needs a client calls `createClient` itself, so a broken create fails *that* test at the create call instead of going vacuously green later. See note below. |
| 2 | Real error text, reuse `errorChain()` | `createClient fails closed when the caller has no tenant membership` -> `errorChain()` matched against `/no tenant for user/i`. |
| 3 | Service-level cross-tenant denial | `another tenant cannot read, list, update or soft-delete this tenant client`: `getClient` -> `null`, `listClients` excludes it (and *contains* the other tenant's own row), `updateClient` -> `null`, `softDeleteClient` -> `false`, then re-read as `userS` proving `goals` unchanged and `deletedAt` still null. |
| 4 | `getClient` random UUID -> `null` | `getClient returns null for an unknown uuid (does not throw)` (`crypto.randomUUID()`). |
| 5 | `softDeleteClient` second call -> `false` | `softDeleteClient is not idempotent-true: a second call returns false`. |
| 6 | `updateClient` bumps `updatedAt` | `updateClient patches fields and bumps updatedAt` — asserts strict advance, also asserts `createdAt` unchanged and an unpatched field survives. |
| 7 | `updateClient` on soft-deleted -> `null` | `updateClient returns null for a soft-deleted client`. |

**Note on requirement 1.** The brief offered "guards, or move the create into `beforeAll`".
Neither works cleanly once requirements 5/6/7 exist: req 6 needs a *live* row with captured
timestamps, reqs 5/7 need an *already-deleted* row, and the plan's single `createdId` is
soft-deleted mid-suite. Per-test creation removes the shared mutable id entirely, which meets
the stated rationale ("an assertion must not go green precisely when setup broke") more strictly
than a guard would. `beforeAll` now only seeds tenants and memberships.

Extras beyond the brief: `createClient` asserts `lawfulBasis` defaults to
`art_9_2_h_healthcare` and `deletedAt` is null; `listClients` asserts every returned row has
`tenantId === tenantIdS` and `deletedAt === null`.

## RED evidence

```
$ pnpm test:int -- clients-rls
 RUN  v4.1.9 /home/skiaourt/extra/dietcms

 ❯ tests/integration/clients-rls.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/integration/clients-rls.test.ts [ tests/integration/clients-rls.test.ts ]
Error: Cannot find module '../../lib/clients' imported from /home/skiaourt/extra/dietcms/tests/integration/clients-rls.test.ts
 ❯ tests/integration/clients-rls.test.ts:7:1
      5| import { tenants, tenantMembers, clients } from '../../db/schema'
      6| import { eq, or } from 'drizzle-orm'
      7| import {
       | ^
      8|   createClient,
      9|   getClient,

 Test Files  1 failed | 1 passed (2)
      Tests  12 passed (12)
[ELIFECYCLE] Command failed with exit code 1.
```

The whole file fails at import resolution, so the 5 pre-existing RLS tests go red with it.
That is the plan's stated expectation ("`lib/clients` has no such exports"); I did not build
throwing stubs to manufacture per-test RED.

## GREEN evidence

```
$ pnpm test:int -- clients-rls
 Test Files  2 passed (2)
      Tests  27 passed (27)
   Duration  22.83s
```

Per-test breakdown, verbose run of just this file at the committed tree
(`pnpm vitest run --config vitest.integration.config.ts clients-rls --reporter=verbose`):

```
 ✓ clients RLS isolation > userA inserts a client into their own tenant 567ms
 ✓ clients RLS isolation > userA sees their own client 251ms
 ✓ clients RLS isolation > userB does NOT see userA's client 258ms
 ✓ clients RLS isolation > cross-tenant insert is rejected by WITH CHECK 235ms
 ✓ clients RLS isolation > empty userId sees zero rows (fail-closed) 232ms
 ✓ client-service > createClient sets tenant_id from the caller and returns the row 405ms
 ✓ client-service > createClient fails closed when the caller has no tenant membership 236ms
 ✓ client-service > getClient returns the created client 568ms
 ✓ client-service > getClient returns null for an unknown uuid (does not throw) 240ms
 ✓ client-service > listClients returns the caller own live clients 549ms
stdout: updatedAt delta ms = 352
 ✓ client-service > updateClient patches fields and bumps updatedAt 653ms
 ✓ client-service > softDeleteClient hides the client from get/list 1831ms
 ✓ client-service > softDeleteClient is not idempotent-true: a second call returns false 815ms
 ✓ client-service > updateClient returns null for a soft-deleted client 770ms
 ✓ client-service > another tenant cannot read, list, update or soft-delete this tenant client 2646ms

 Test Files  1 passed (1)
      Tests  15 passed (15)
```

An earlier verbose run (before I refactored the `updatedAt` assertion from
`expect(c!.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())` to
`expect(delta, ...).toBeGreaterThan(0)` — semantically identical, better failure message)
reported `updatedAt delta ms = 905`. Two datapoints: **352ms and 905ms**.


```
$ pnpm test
 Test Files  7 passed (7)
      Tests  21 passed (21)

$ pnpm typecheck
$ tsc --noEmit
(no output)

$ pnpm lint
$ eslint .
(no output)
```

The brief's predicted friction did not materialise: `listClients` returning drizzle's
`QueryPromise` directly satisfies `Promise<Client[]>` and typechecks. No signature changed.

## Files changed

- `lib/clients.ts` (new, 82 lines)
- `tests/integration/clients-rls.test.ts` (+132 lines: `lib/clients` import + `client-service` describe)

## Self-review

- No `withUser` or `authedDb.transaction()` nested inside a `withUser` callback anywhere in
  `lib/clients.ts` — verified by reading the file; `callerTenantId` is the only helper and it
  takes `tx`.
- No `permission denied for table clients` in any run, so foundation's
  `ALTER DEFAULT PRIVILEGES` grant did reach the table.
- `FOR ALL` policy covers the soft-delete UPDATE; no extra policy added.
- `afterAll` deletes via the owner connection, which reaps soft-deleted rows too (they are
  still physically present). `userNone` is never inserted, so it needs no cleanup.
- Every test in the new describe uses a `Date.now()`-derived run id, so re-runs do not collide.

## Concerns

1. **`updatedAt` mixes two clocks — a real defect in the plan, not just test flake.**
   `createdAt`/`updatedAt` default to the *DB* clock (`defaultNow()`), but `updateClient` writes
   the *app* clock (`new Date()`). I measured this box against Neon: DB clock ~32ms ahead,
   warm RTT ~57ms. The observed test margins were **905ms and 352ms** across two runs — 11x
   the adverse skew at the worse of the two — so I kept the plan's `new Date()`.
   But on Vercel, a function whose clock lags Neon's by more than the elapsed time will persist
   `updatedAt < createdAt` immediately after a patch. Fix is one line — `updatedAt: sql`now()`` —
   an internal change with no signature impact. I did not make it because it is a deviation the
   brief did not authorise; recommend it be decided at Task 3 when audit timestamps land and
   the same question repeats.

2. **Mass assignment through the patch/input spread.** `updateClient` does
   `.set({ ...patch, updatedAt })`. `updatedAt` wins because it is last, and a `tenantId`
   injection would be caught by the RLS `WITH CHECK`. But a runtime
   `patch = { deletedAt: null }` (TypeScript cannot stop it once the object comes from parsed
   JSON typed as `Partial<NewClient>`) would **un-delete a soft-deleted client**, and nothing
   overrides it. Same shape in `createClient`'s `{ ...input, tenantId }` — e.g. an injected
   `lawfulBasis` or `createdAt`. Route handlers are out of scope for Task 2, so the input
   validation belongs there, but the service is not self-defending and I want that on record
   rather than assumed handled.

3. **`callerTenantId` relies on `tenant_members` having exactly one row per user.**
   It is `select ... limit 1` with no `where` and no ordering. Today `tenant_members` has
   `unique('tenant_members_user_id_unique').on(user_id)` (`db/schema.ts:36`), so one row is
   guaranteed and the `limit 1` is safe. The moment multi-tenant membership is allowed, this
   silently picks an arbitrary tenant — and so does the `clients` RLS policy itself, which uses
   the same `limit 1` subquery (`db/schema.ts:89`). Not a bug now; it is a landmine that fires
   in two places at once.

4. **`pnpm test:int -- clients-rls` does not actually filter.** The `--` makes pnpm pass the
   arg through, but vitest ignores it as a name filter, so both integration files run (27 tests,
   not 15). Harmless — the brief's command is what I ran and pasted — but the "clients-rls" in
   it is decorative. `pnpm vitest run --config vitest.integration.config.ts clients-rls` filters
   correctly if a later task wants that.

5. **The `updatedAt` test keeps a `console.log`.** Deliberate: it prints the skew margin on
   every green run so a future flake has a trend, not a mystery. Remove it if the project would
   rather have silent test output.

6. **Integration tests are not hermetic** — they hit the shared Neon dev DB and depend on
   `.env.local`. Concurrent runs against the same database are fine (run ids are time-derived,
   RLS scopes every assertion to the run's own tenant), but a failed run leaves rows behind
   because `afterAll` does not run on a hard crash. Pre-existing condition, not introduced here.
