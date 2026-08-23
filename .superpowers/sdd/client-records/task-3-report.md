# Task 3 report — `audit_log` (append-only) + audit-service wired into client-service

Branch `feat/client-records`, on top of `bf539d0`.

## What was implemented

| File | Change |
|---|---|
| `db/schema.ts` | `auditLog` table + `audit_log_tenant_isolation` policy, `enableRLS()`. `jsonb` added to the pg-core import. |
| `db/migrations/0004_perpetual_marten_broadcloak.sql` | Generated, then hand-edited: `FORCE ROW LEVEL SECURITY` + `REVOKE UPDATE, DELETE … FROM "authenticated_backend"`. |
| `lib/audit.ts` (new) | `AuditAction`, `AuditArgs`, `recordAudit(tx, args)` — the only writer of `audit_log`. |
| `lib/clients.ts` | Audit wired into all five paths: `createClient`, `getClient`, `listClients`, `updateClient`, `softDeleteClient`. |
| `tests/helpers/error-chain.ts` (new) | `errorChain()` extracted out of `clients-rls.test.ts`. |
| `tests/integration/clients-rls.test.ts` | Imports the extracted helper; `afterAll` now also reaps `audit_log` (see below). |
| `tests/integration/audit-append-only.test.ts` (new) | 22 tests across 7 describes. |

All six audited operations from spec §5 are wired: `create`, `view` (read-one),
`view` (list — `entity_id` and `client_id` null, `metadata {count}`), `update`,
`delete`. Read/mutate paths that matched no row write no audit row; the list path
audits unconditionally.

No `new Date()` anywhere. `at` is `defaultNow()`, `actor_user_id` is
`current_setting('app.user_id', true)` — both DB-side.

## Migration verification

`pnpm db:generate` produced exactly one new `.sql`, one new snapshot and the
journal entry. The SQL contains only `audit_log` DDL — the single mention of
another table is `tenant_members` inside the policy predicate, not a schema
change. `pnpm db:migrate` applied cleanly; post-apply introspection:

```
        grantee        | privilege_type
-----------------------+----------------
 authenticated_backend | INSERT
 authenticated_backend | SELECT
(2 rows)

 relrowsecurity | relforcerowsecurity
----------------+---------------------
 t              | t
```

## RED evidence

### Stage 1 — nothing exists yet

```
 FAIL  tests/integration/audit-append-only.test.ts [ tests/integration/audit-append-only.test.ts ]
Error: Cannot find module '../../lib/audit' imported from .../tests/integration/audit-append-only.test.ts
 ❯ tests/integration/audit-append-only.test.ts:14:1
 Test Files  1 failed | 2 passed (3)
      Tests  30 passed (30)
```

### Stage 2 — schema + migration + `lib/audit.ts` landed, service NOT yet wired

An import error alone is not evidence for the wiring, so this stage isolates it.
Exactly the seven wiring assertions fail; grants/RLS shape, append-only,
isolation, denylist and rollback already pass.

```
 ❯ tests/integration/audit-append-only.test.ts (22 tests | 7 failed) 13030ms
     × createClient writes exactly one create row 535ms
     × getClient writes a view row 773ms
     × updateClient writes an update row 886ms
     × softDeleteClient writes a delete row 745ms
     × a second softDeleteClient does not write a second delete row 1055ms
     × each listClients call appends exactly one client-less view row 987ms
     × listClients fails closed for a caller with no membership 236ms
      Tests  7 failed | 45 passed (52)
```

## GREEN

```
 Test Files  3 passed (3)
      Tests  52 passed (52)
```

## Forcing tests (break the guard, prove red, restore, prove green)

### A — re-GRANT `UPDATE, DELETE` on `audit_log` (req 2 + 3)

```
psql -c 'GRANT UPDATE, DELETE ON "audit_log" TO "authenticated_backend";'
 privilege_type
----------------
 DELETE
 INSERT
 SELECT
 UPDATE
```
```
     × authenticated_backend has INSERT+SELECT and NOT UPDATE/DELETE 450ms
     × CANNOT UPDATE an audit row (permission denied, not RLS) 234ms
     × CANNOT DELETE an audit row (permission denied, not RLS) 257ms

 FAIL  … authenticated_backend has INSERT+SELECT and NOT UPDATE/DELETE
AssertionError: expected [ 'INSERT', 'SELECT', 'UPDATE', …(1) ] to not include 'UPDATE'
 FAIL  … CANNOT UPDATE an audit row (permission denied, not RLS)
AssertionError: expected the query to reject: expected null to be truthy
 FAIL  … CANNOT DELETE an audit row (permission denied, not RLS)
AssertionError: expected the query to reject: expected null to be truthy
      Tests  3 failed | 49 passed (52)
```
Restored (`REVOKE UPDATE, DELETE`) → `Tests  52 passed (52)`.

### A2 — `ALTER TABLE audit_log NO FORCE ROW LEVEL SECURITY` (req 3)

```
     × audit_log has RLS both enabled and FORCEd 69ms
AssertionError: expected 'false' to be 'true' // Object.is equality
      Tests  1 failed | 51 passed (52)
```
Restored (`FORCE ROW LEVEL SECURITY`, `relforcerowsecurity = t`) → `Tests  52 passed (52)`.

### B1 — delete the PII denylist check in `recordAudit` (req 6 + 7)

```
     × rejects a denylisted metadata key 286ms
     × accepts PII-free metadata 343ms
     × a denylist rejection rolls back the client insert 361ms
      Tests  3 failed | 49 passed (52)
```
(`accepts PII-free metadata` also flips because the previously-rejected row now
persists in that tenant, so its exact-count assertion sees two rows — the
count-based assertion is doing real work.)

### B2 — wrap the audit INSERT in `try {} catch {}` so an audit failure is swallowed (req 7)

```
     × a DB-level failure inside the audit INSERT rolls back the client insert 367ms
AssertionError: expected the query to reject: expected null to be truthy
      Tests  1 failed | 51 passed (52)
```

### C — remove the `listClients` audit row (req 1 + 4)

```
     × each listClients call appends exactly one client-less view row 1188ms
     × listClients fails closed for a caller with no membership 254ms
AssertionError: expected [] to have a length of 1 but got +0
      Tests  2 failed | 50 passed (52)
```
Restored → `Tests  52 passed (52)`.

## How requirement 7 (rollback) was triggered

Two cases, primary first:

1. **DB-level** — inside a `withUser` transaction that had already inserted a
   client, `recordAudit` is called with `entityId: 'not-a-uuid'`, so the audit
   `INSERT` itself fails in Postgres (`invalid input syntax for type uuid`). The
   owner connection then shows zero client rows for that tenant. This proves the
   *audit write* failing aborts the mutation, not merely that a thrown callback
   rolls back.
2. **JS-level** — a denylisted metadata key makes `recordAudit` throw before any
   SQL; same owner assertion.

Both assert through `db` (owner, BYPASSRLS) so RLS cannot be the reason a row
appears missing, and both capture the inserted id in the callback and assert it
is truthy — otherwise "no client row" would pass if the insert had never run.

### Honest limitation of these two tests

In forcing test B2 only the `errorChain` half went red. `expect(after.clients)
.toHaveLength(0)` stayed green, because with the audit failure swallowed
Postgres still aborted the transaction on its own (a `COMMIT` in aborted state
degrades to `ROLLBACK`) — `createClient` merely returned a row that does not
exist, which is what the rejection assertion caught.

So **the persisted-state half of both rollback tests has never been seen to
fail.** The sharper reason: these tests hand-roll their own `withUser`
transaction, so no change to `lib/clients.ts` or `lib/audit.ts` can move the
audit write outside it. That assertion guards the test's own composition, not
the service's — it is structurally unfalsifiable by an implementation break,
which is weaker than "proven." Recording it rather than claiming otherwise.

**What would close it** (not built — outside this task's scope): a separate test
file that `vi.mock`s `../../lib/audit` so `recordAudit` throws, calls the real
`createClient`, and asserts via the owner connection that no client row
persisted. That version *is* forceable: move `createClient`'s `recordAudit` call
into a second `withUser` — the exact defect load-bearing fact #1 warns about —
and the persisted-state assertion goes red.

## Deliberate deviations / decisions

1. **`client_id` column kept** (spec §4 has no such column). Task 5's erasure has
   to find audit rows referencing an erased client, and Task 6's coverage
   tripwire keys off client-scoped columns. Recorded in a schema comment so it is
   not "fixed" later.
2. **No FK on `client_id`.** `ON DELETE CASCADE` would *delete* audit rows on
   erasure (spec §5 says anonymize); `RESTRICT`/`NO ACTION` would block erasure
   outright. Deliberate, commented in the schema.
3. **`recordAudit` accepts an optional pre-resolved `tenantId`** (gap 9 — done).
   `createClient` passes the value `callerTenantId(tx)` already resolved, saving
   a second identical `tenant_members` round trip per create. The other four
   paths keep their own lookup because there it doubles as the fail-closed guard.
   A forged `tenantId` is safe: the policy's `WITH CHECK` rejects a foreign
   tenant (proven by the `cross-tenant audit INSERT` test).
4. **`tx: typeof authedDb`** (gap 8), imported as `import type { authedDb }` so
   `lib/audit.ts` pulls in no pool at runtime. The plan's dead `AuditTx` type was
   not created.
5. **`lib/pii-denylist.ts` untouched.** No metadata key anywhere is denylisted:
   the only key the service writes is `count`.
6. **`tests/helpers/error-chain.ts` imports `expect` from `vitest` explicitly** —
   the repo tsconfig has no `vitest/globals` types and `pnpm typecheck` covers
   `**/*.ts`, so a bare global `expect` would not compile there.

## Behaviour change to a Task 2 contract

`listClients` now **throws** `no tenant for user` for a caller with no
`tenant_members` row, where it previously returned `[]`. The list audit row is
unconditional (spec §5), and `recordAudit`'s membership lookup fails closed, so
an unauditable list must not succeed. Deliberate, pinned by
`listClients fails closed for a caller with no membership`. No existing test
called the read paths with a membership-less user (only
`createClient(userNone, …)` in `clients-rls.test.ts`), so nothing else changed.

The read-one/update/delete paths are unaffected: their audit call is guarded on a
row having been found, and if RLS returned a row the membership is already
proven, so that throw is unreachable there.

## Test-data leak found and fixed after the first commit

Wiring audit into all five service methods made `clients-rls.test.ts`'s
`client-service` describe write a few dozen `audit_log` rows per run. Its
`afterAll` reaped `clients` / `tenant_members` / `tenants` but not `audit_log`,
and `audit_log.tenant_id` has no FK (deliberate), so those rows were orphaned
permanently — and the request role has no DELETE grant, so only the owner path
can reap them. The suite, typecheck and lint all stayed green while the shared
Neon dev DB grew on every `pnpm test:int`.

Fixed by adding an `auditLog` delete to that `afterAll`, before the tenants
delete, mirroring the new file's `reap()` ordering. The first describe
(`clients RLS isolation`) needs nothing — it uses raw `tx.insert(clients)`, no
service call, so it writes no audit rows.

The 237 rows already orphaned by today's runs were reaped through the owner
connection; a full `pnpm test:int` afterwards leaves `select count(*) from
audit_log` at 0 with 0 orphans.

## Verification

| Command | Result |
|---|---|
| `pnpm test:int` | `Test Files 3 passed (3)` / `Tests 52 passed (52)` |
| `pnpm test` | `Test Files 7 passed (7)` / `Tests 21 passed (21)` |
| `pnpm typecheck` | clean (no output) |
| `pnpm lint` | clean (no output) |

## Self-review

- `recordAudit` never opens its own connection or transaction — it only ever
  touches the `tx` handed in. No `withUser` / `authedDb.transaction()` nesting
  was introduced anywhere.
- Every negative assertion matches a specific message (`/permission denied/i`,
  `/row-level security/i`, `/invalid input syntax for type uuid/i`,
  `/denylist/i`, `/no tenant for user/i`) through `errorChain`. No bare
  `.rejects.toThrow()` in the new file.
- Every isolation assertion carries a positive control, so an empty result cannot
  pass for the wrong reason.
- The `UPDATE`/`DELETE`-denied tests additionally re-read the row through the
  owner to prove nothing was written before the rejection.
- Test data is namespaced per describe with a `Date.now().toString(36)` suffix and
  reaped in `afterAll` through the owner connection (which also reaps
  soft-deleted rows). Each describe owns its own tenant, so the list-view row
  (`client_id` null, hence unfilterable) is countable.

## Concerns

1. **Denied access attempts are not logged — spec question for the owner (raise,
   not build).** `getClient` writes a `view` row only when a row was actually
   returned, so a cross-tenant read attempt (RLS returns nothing) leaves no trace
   at all. Same for `updateClient` / `softDeleteClient` against a foreign id. For
   a clinical record system, the denied attempts are usually the ones you most
   want in the trail — they are the signal for credential misuse, whereas
   successful own-tenant reads are routine. The spec does not require it, and it
   was deliberately not built here.
   **Recommendation:** add a `deny` action (or `view` with
   `metadata: { outcome: 'denied' }`) written on the miss branch of the three
   per-client paths. Note the wrinkle: a denied attempt has no resolvable tenant
   from the target row, so the row must be attributed to the *caller's* tenant,
   and a caller with no membership cannot be logged on the request path at all —
   that case needs the owner path or an application log. Worth deciding before
   Task 5, since erasure/export semantics differ for rows about clients in
   another tenant.
2. **Not covered by the coverage tripwire yet.** `audit_log` has a `client_id`
   column, so Task 6's tripwire will demand that `exportClient`/`eraseClient`
   both handle it. Expected — flagging so Task 6 does not treat it as drift.
3. **Every future test that touches the client service must reap `audit_log`.**
   `audit_log.tenant_id` has no FK, so dropping a tenant orphans its audit rows,
   and the request role cannot delete them. Tasks 4–6 will hit this; the
   `reap()` helper in `tests/integration/audit-append-only.test.ts` is the
   pattern to copy.
4. **The list audit row has no filter dimension.** `entity_id` and `client_id`
   are both null by spec, so list rows can only be counted per tenant/actor. If
   list auditing later needs to be queryable (e.g. "who listed clients last
   week"), `at` + `actor_user_id` are the only handles. No index was added (out of
   scope), and `audit_log` is append-only and will grow monotonically — an index
   on `(tenant_id, at)` and `(client_id)` will be needed before this table is read
   in anger.
5. **Audit rows are never re-read by the request path today.** `SELECT` is
   granted and tenant-isolated, and tested, but nothing in the app reads the
   trail yet. That surface is untested beyond isolation.
