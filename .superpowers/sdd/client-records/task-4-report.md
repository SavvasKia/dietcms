# Task 4 report — `client_consents` + consent-service

Branch `feat/client-records`, on top of `20c3f28`.

Includes the mid-task **scope addition** from the owner: the partial unique index
(previously "raise, do not implement") is built, and `grantConsent` gained
supersede semantics.

## What was implemented

| File | Change |
|---|---|
| `db/schema.ts` | `clientConsents` table, `client_consents_tenant_isolation` policy, `enableRLS()`, and the partial `uniqueIndex('client_consents_one_active_per_scope')`. `uniqueIndex` added to the pg-core import. |
| `db/migrations/0005_glossy_mister_fear.sql` | Generated, then hand-edited to add `FORCE ROW LEVEL SECURITY`. **No REVOKE** — this table needs full CRUD. |
| `db/migrations/meta/0005_snapshot.json`, `meta/_journal.json` | Generated. |
| `lib/consents.ts` (new) | `ConsentScope`, `CONSENT_SCOPES`, `grantConsent`, `withdrawConsent`, `activeConsents`, plus `assertScope` / `reachableClient` / `activeScope` / `callerTenantIdOrNull` / `recordDeny`. |
| `tests/integration/consents-rls.test.ts` (new) | 41 tests across 7 describes. |

Nothing else touched: `lib/pii-denylist.ts`, `lib/audit.ts`, `lib/clients.ts` and
every existing test are unmodified. No GDPR export/erase, no coverage tripwire,
no routes, no UI.

### Service contract as built

```ts
grantConsent(userId, clientId, scope, textVersion): Promise<Consent | null>
withdrawConsent(userId, clientId, scope): Promise<boolean>
activeConsents(userId, clientId): Promise<ConsentScope[]>
export const CONSENT_SCOPES  // the closed set, and the activeConsents result order
```

## The three plan defects

### 1. Cross-tenant integrity hole in `grantConsent` — fixed

`reachableClient(tx, clientId)` resolves the client under RLS
(`id = ? and deleted_at is null`) before anything is written. Unreachable
(unknown / soft-deleted / another tenant's) → a `deny` audit row and `null`.

`reachableClient` also returns the row's `tenant_id`, which **is** the caller's
tenant: the policy's USING clause only admits rows whose `tenant_id` equals the
caller's membership tenant. That removes a second membership round trip, and the
insert's WITH CHECK still rejects a mismatch if the policy were ever loosened.

**Signature deviation from the plan:** `Promise<Consent | null>`, not
`Promise<Consent>`. Forced, not stylistic — throwing would roll the transaction
back and take the `deny` row with it, so the brief's required "no row + a deny
row" outcome is unreachable with a throw. Consistent with `getClient` /
`updateClient`, which also return null on an unreachable client.

### 2. Withdrawal is not total — fixed, and now also enforced in the DB

`withdrawConsent` issues **one** `update … where client_id = ? and scope = ? and
withdrawn_at is null`, so every active row is stamped; it returns true when at
least one row changed, and writes one `update` audit row per row that actually
changed state.

The owner's scope addition layers a DB-level guarantee on top — see
"Partial unique index" below, including whether the service fix is now dead code.

### 3. `activeConsents` — one query, no ORDER BY at all

Option 2 from the brief: `select distinct scope … where client_id = ? and
withdrawn_at is null`, then filtered through `CONSENT_SCOPES` for a stable order
and to keep an out-of-band scope value out of the typed result.

**Why option 2 is defensible:** once withdrawal is total, "the scope has an
active row" is *equivalent* to "the latest row for the scope is active" — an
active row can only have been granted after the last withdrawal of that scope, so
it is necessarily the latest. The equivalence means the query needs no ordering,
and therefore **tie-breaking is structurally absent rather than
test-enforced** — there is no `granted_at` ordering anywhere in `lib/consents.ts`
to add an `id desc` tiebreaker to. The tie case is still covered by a test that
seeds two rows with byte-identical `granted_at` (one INSERT, `sql`now()`` twice).
The plan's version fails that test — see RED stage 2, failure 3/18.

## Also required (brief items 4–9)

| # | Requirement | Where |
|---|---|---|
| 4 | Runtime `scope` validation | `assertScope`, called before `withUser` so no transaction is opened for a bad scope. Both guarded entry points are `async` so a bad scope **rejects** rather than throwing synchronously (a sync throw out of a Promise-returning function slips past the caller's `.catch()`). |
| 5 | Deny logging on the per-client paths | `recordDeny` copied from `lib/clients.ts` — `action: 'deny'`, `entity: 'consent'`, `entityId: null`, `clientId: null`, `metadata: { outcome: 'denied' }`, caller's tenant, **silently skipped** for a membership-less caller. Applied to all three paths (grant too, not just the two named). |
| 6 | `activeConsents` writes a `view` row | `entity: 'consent'`, `clientId` set, `entityId: null` (a collection read, like `listClients`), `metadata: { count }`. |
| 7 | Isolation tests | Describe 7: cross-read with positive control, cross-INSERT rejected by WITH CHECK via `errorChain` + `/row-level security/i`, cross-UPDATE and cross-DELETE match zero rows, empty-userId fail-closed, plus the service-level refusal. |
| 8 | RLS shape assertions | `relrowsecurity::text` / `relforcerowsecurity::text` both `'true'`, policy present in `pg_policies`, `authenticated_backend` grants include SELECT/INSERT/**UPDATE**/DELETE (the no-REVOKE fact), FK `delete_rule = CASCADE`, and the index predicate via `pg_indexes.indexdef`. |
| 9 | Lifecycle audit rows | grant → `create` + `metadata { scope }`; withdraw → `update` + `{ scope, withdrawn: true }`; supersede → `create` + `{ scope, superseded: true }`. All with `entity: 'consent'` and `clientId` set. |

No `new Date()` in anything this task added: `granted_at` uses the column's
`defaultNow()`, `withdrawn_at` uses `const dbNow = sql`now()``, and the test seeds
that need a timestamp also use `sql`now()``. Verified with
`rg -n 'new Date\(' lib/ tests/ db/` — zero hits in `lib/` and `db/`, and the only
two hits in `tests/` are the pre-existing deliberate forged timestamps in
`tests/integration/clients-rls.test.ts` (Task 2's mass-assignment probes).

## Partial unique index + supersede (owner scope addition)

Schema:

```ts
uniqueIndex('client_consents_one_active_per_scope')
  .on(t.clientId, t.scope)
  .where(sql`withdrawn_at is null`)
```

Generated SQL — the WHERE predicate **is** present (verified in the file and in
`pg_indexes`):

```sql
CREATE UNIQUE INDEX "client_consents_one_active_per_scope" ON "client_consents"
  USING btree ("client_id","scope") WHERE withdrawn_at is null;
```

`grantConsent` implements SUPERSEDE in its single transaction: resolve the client
→ `update … set withdrawn_at = now() where (client_id, scope) active` →
insert the new row. Withdraw before insert, or the insert trips the index.

Audit: the supersede is ONE logical event — the `create` row carries
`metadata: { scope, superseded: true }` and **no** separate `update`/withdraw row
is emitted. I agree with that call and implemented it as specified. The
`superseded` flag is what makes the two cases distinguishable in the trail, and
the superseded row's own `withdrawn_at` records when it stopped applying.

### Does the index make the defect-2 fix dead code?

Partly — and the forcing runs pin down exactly how far.

- With the index in place, **no path can construct two simultaneously-active
  rows** — not the service, and not the owner connection either (the index is not
  a policy, so BYPASSRLS does not help). So `withdrawConsent`'s multi-row branch
  is *unreachable in the current schema*, and no black-box test can distinguish
  "withdraw all" from "withdraw the latest".
- It is **not** dead code in the world the index does not cover: forcing run F7a
  (index dropped, supersede removed = the plan) leaves a stranded active row and
  the test goes red; F7b (same, but withdraw-all restored) makes that assertion
  pass again. So the totality of `withdrawConsent` is what repairs a pre-index or
  out-of-band double-active row, and that is the case it now exists for.

I kept it, per the brief. It is a set-based `UPDATE … WHERE` — there is no extra
query and no branch to rot. **For whoever reads this next: the multi-row branch is
unreachable only while the index exists. If a future migration drops
`client_consents_one_active_per_scope`, `withdrawConsent`'s totality is the only
thing left standing between that migration and stranded consents — do not remove
both.**

## RED evidence

### Stage 1 — test file only, nothing implemented

```
 FAIL  tests/integration/consents-rls.test.ts [ tests/integration/consents-rls.test.ts ]
Error: Cannot find module '../../lib/consents' imported from /home/skiaourt/extra/dietcms/tests/integration/consents-rls.test.ts
 ❯ tests/integration/consents-rls.test.ts:16:1

 Test Files  1 failed | 3 passed (4)
      Tests  58 passed (58)
```

### Stage 2 — schema + migration landed, `lib/consents.ts` = **the plan verbatim**

This run *is* the "break the guard, prove red" half of the forcing discipline for
defects 1, 2 and 3 and for requirements 4 and 5: the code under test is the
plan's own implementation, defects and `new Date()` included. The index was
temporarily dropped on the owner connection for this run so the plan's defects
manifest as the brief describes them rather than as a unique violation.

```
      Tests  18 failed | 81 passed (99)
```

The 18, with the assertion each died on:

| # | Test | Failure |
|---|---|---|
| 1 | `carries the partial unique index, WHERE predicate included` | index missing (deliberately dropped for this run) |
| 2 | `activeConsents writes a view row with client_id set (req 6)` | `expected [] to have a length of 1` — the plan writes no view row |
| 3 | `ties on granted_at resolve deterministically to active` | `expected [] to deeply equal [ 'third_party_sharing' ]` — **defect 3**, `order by granted_at desc limit 1` picked the withdrawn row |
| 4 | `defect 1 › inserts nothing and writes a deny row` | returned the inserted row: `{ clientId: 942974ab…, tenantId: b6de456a… }` — **the cross-tenant row the brief predicted** |
| 5 | `defect 1 › an unknown uuid is denied the same way` | `violates foreign key constraint "client_consents_client_id_clients_id_fk"` — the plan throws instead of denying |
| 6 | `defect 1 › a soft-deleted client is unreachable` | returned a row |
| 7 | `defect 2 › a re-grant supersedes the live row` | `expected 2 active rows to have a length of 1` |
| 8 | `defect 2 › the supersede is audited as one create event` | `{ scope: 'marketing' }` vs `{ scope, superseded: true }` |
| 9 | `defect 2 › a second simultaneously-active row is rejected by the index` | did not reject (index dropped) |
| 10 | `defect 2 › after a chain of grants, one withdraw leaves zero active rows` | `an active row survived: expected 2 rows to have a length of 0` — **defect 2** |
| 11–13 | `req 4 ›` all three scope-validation tests | `expected the query to reject` — no validation at all |
| 14–16 | `req 5 ›` the three deny-row tests | `expected [] to have a length of 1 / 1 / 2` |
| 17 | `req 5 › a membership-less caller … no exception` | `Error: no tenant for user` thrown from `lib/consents.ts:27` |
| 18 | `req 7 › the consent-service refuses a cross-tenant client` | returned the inserted row |

Full log: `stage2.log` in the session scratchpad (not committed).

## GREEN

```
 Test Files  4 passed (4)
      Tests  99 passed (99)
```

58 pre-existing + 41 new.

One real bug was found *by* the forcing runs, in my own test rather than in the
code: `the supersede is audited as one create event` matched audit rows
positionally (`creates[0]`) on a select with no ORDER BY, and flaked once. Now
matched by `entity_id`.

## Forcing tests (break, prove red, restore, prove green)

Each run below is the new file only
(`pnpm exec vitest run --config vitest.integration.config.ts tests/integration/consents-rls.test.ts`,
41 tests) — the four gates were run in full at the end. Schema breaks were
restored with explicit owner-connection SQL, **not** `db:migrate`: the journal
marks 0005 applied, so drizzle will not re-run it.

### F1 — `ALTER TABLE client_consents NO FORCE ROW LEVEL SECURITY` (req 8)

```
 FAIL  … > client_consents privilege + RLS shape > client_consents has RLS both enabled and FORCEd
      Tests  1 failed | 40 passed (41)
```
Restored (`FORCE ROW LEVEL SECURITY`): `Tests  41 passed (41)`.

### F2 — `DROP POLICY client_consents_tenant_isolation` (req 8)

```
      Tests  19 failed | 11 passed | 11 skipped (41)
```
Including the dedicated `client_consents carries its tenant-isolation policy`.
RLS with no policy denies everything, so the behavioural suites collapse too —
which is itself the point: the shape test names the cause, the rest only show
symptoms. Restored with the policy DDL copied verbatim from the migration and
verified via `pg_get_expr(polqual/polwithcheck)`: `Tests  41 passed (41)`.

### F3 — `assertScope(scope)` deleted from both entry points (req 4)

```
 FAIL  … > scope is validated at runtime (req 4) > grantConsent rejects an unknown scope and writes nothing
 FAIL  … > scope is validated at runtime (req 4) > withdrawConsent rejects an unknown scope
 FAIL  … > scope is validated at runtime (req 4) > the empty string is not a scope
      Tests  3 failed | 38 passed (41)
```
Restored: `Tests  41 passed (41)`.

### F4 — all three `await recordDeny(tx)` calls deleted (req 5)

```
 FAIL  … > defect 1 > inserts nothing and writes a deny row in the caller tenant
 FAIL  … > defect 1 > an unknown uuid is denied the same way
 FAIL  … > req 5 > activeConsents on an unreachable client returns [] and writes a deny row
 FAIL  … > req 5 > withdrawConsent on an unreachable client returns false and writes a deny row
 FAIL  … > req 5 > an unknown uuid counts as a denied attempt too
      Tests  5 failed | 36 passed (41)
```
Restored: `Tests  41 passed (41)`.

### F5 — `reachableClient` guard removed from `grantConsent` only (defect 1)

Replaced with the plan's `callerTenantIdOrNull` + trusted `clientId` argument;
`withdrawConsent` / `activeConsents` left intact, so this isolates the one guard.

```
 FAIL  … > defect 1 > inserts nothing and writes a deny row in the caller tenant
 FAIL  … > defect 1 > an unknown uuid is denied the same way
 FAIL  … > defect 1 > a soft-deleted client is unreachable, so its consents cannot be granted
 FAIL  … > defect 1 > the victim can still grant consent on their own client
 FAIL  … > req 7 > the consent-service refuses a cross-tenant client (service-level)
      Tests  5 failed | 36 passed (41)
```
Restored: `Tests  41 passed (41)`.

### F6 — `DROP INDEX client_consents_one_active_per_scope`, code untouched

```
 FAIL  … > client_consents privilege + RLS shape > carries the partial unique index, WHERE predicate included
 FAIL  … > defect 2 > a second simultaneously-active row is rejected by the unique index
      Tests  2 failed | 39 passed (41)
```
Restored (recreated with the predicate): `Tests  41 passed (41)` (after fixing the
positional-audit flake this run exposed).

### F7 — the defect-2 pair: is `withdrawConsent`'s totality load-bearing?

**F7a — index dropped + supersede step removed + the plan's latest-only
withdrawal** (i.e. exactly the plan's world):

```
 FAIL  … > defect 2 > after a chain of grants, one withdraw leaves zero active rows
AssertionError: expected [ 'portal_access' ] to deeply equal []
 ❯ tests/integration/consents-rls.test.ts:491
      Tests  5 failed | 36 passed (41)
```
The scope is still reported **active after being withdrawn** — defect 2, live.

**F7b — same, but `withdrawConsent` restored to withdraw-all:**

```
 FAIL  … > defect 2 > after a chain of grants, one withdraw leaves zero active rows
AssertionError: expected [ 3 rows ] to have a length of 1 but got 3
 ❯ tests/integration/consents-rls.test.ts:497
      Tests  5 failed | 36 passed (41)
```
The failure **moved off** the stranded-row assertion (line 491/493 now pass) onto
the audit-count assertion at line 497, which differs only because the supersede
step is still removed in this variant (3 rows were active, so 3 withdraw rows are
written instead of 1). That is the isolation: withdraw-all, on its own, is what
eliminates the stranded active row.

Both restored (index recreated, supersede and withdraw-all back):
`Tests  41 passed (41)`.

## Migration verification

`db/migrations/0005_glossy_mister_fear.sql` contains, in order:
`CREATE TABLE "client_consents"` · `ENABLE ROW LEVEL SECURITY` ·
**hand-added** `FORCE ROW LEVEL SECURITY` · the FK
`REFERENCES "public"."clients"("id") ON DELETE cascade` ·
`CREATE UNIQUE INDEX … WHERE withdrawn_at is null` ·
`CREATE POLICY "client_consents_tenant_isolation" … FOR ALL TO
"authenticated_backend" USING (…) WITH CHECK (…)`. No REVOKE.

`pnpm db:migrate` applied cleanly. Live state re-verified after all forcing runs:

```
relrowsecurity=true, relforcerowsecurity=true
policyname = client_consents_tenant_isolation
CREATE UNIQUE INDEX client_consents_one_active_per_scope ON public.client_consents
  USING btree (client_id, scope) WHERE (withdrawn_at IS NULL)
```

`git diff` for tracked files is `db/schema.ts` (+46/-1, the table plus the
`uniqueIndex` import) and `meta/_journal.json` (+7, the 0005 entry) — nothing
else.

A second `pnpm db:generate` after committing reports **`No schema changes, nothing
to migrate`** and writes no `0006_*.sql`, so drizzle-kit agrees the snapshot round
-trips — including the partial index's serialized `where` predicate, which is the
part most likely to reappear as a spurious DROP/CREATE pair inside Task 5's
migration.

## Verification

| Gate | Result |
|---|---|
| `pnpm test:int` | `Test Files 4 passed (4)` / `Tests 99 passed (99)` |
| `pnpm test` | `Test Files 7 passed (7)` / `Tests 21 passed (21)` |
| `pnpm typecheck` | clean, exit 0 |
| `pnpm lint` | clean, exit 0 |

Leftover check on the owner connection after a full `pnpm test:int`:

```
audit_log=0  client_consents=0  clients=0  tenants=0  tenant_members=0
```

Zero across the board, including after the F2 run whose `beforeAll` hooks failed
mid-suite. `reap()` deletes `audit_log` first, then `client_consents`, `clients`,
`tenant_members`, `tenants`.

## Self-review

- No nested `withUser` / `authedDb.transaction()` anywhere: `reachableClient`,
  `callerTenantIdOrNull`, `recordDeny` and every `recordAudit` call all take the
  live `tx`.
- Every consent mutation shares its transaction with its audit write, so nothing
  can commit unaudited (the Task 3 property, inherited by construction).
- `metadata` keys used: `scope`, `withdrawn`, `superseded`, `count`, `outcome` —
  all clear of the denylist regex. `pii-denylist.ts` untouched.
- Grants: the table deliberately keeps UPDATE (withdrawal is a request-path
  UPDATE); asserted positively so a future blanket REVOKE turns the suite red.
- Deny rows use `entity: 'consent'`, and every deny query filters on
  `action = 'deny' AND entity = 'consent'` so a `client`-entity deny from setup
  cannot be counted, and a wrong `entity` cannot pass unnoticed.

## Concerns and deviations

1. **`grantConsent` returns `Consent | null`** — deviation from the plan's
   declared interface. Forced by the deny-row requirement (a throw rolls it
   back). Callers in Task 5 / the route layer must handle null as "not found".
2. **A soft-deleted client's consents are unreachable, and probing them logs a
   `deny` row.** Consistent with `getClient`'s Task 2/3 precedent, but Task 5's
   export/erase *must not* go through these functions — an erasure flow needs to
   read the consents of a soft-deleted client, and it would both get `[]` and
   pollute the audit trail with denies. Task 5 needs its own read path (and the
   `CASCADE` on the FK means erasure deletes consent rows anyway, per spec §5).
3. **The "timestamps come from the DB clock" rule is not directly asserted.** The
   test only checks `withdrawn_at >= granted_at`, which the app clock would also
   satisfy on a healthy host. A real assertion would need to compare against the
   transaction's own `now()`, which is not observable from outside. The guarantee
   currently rests on code review plus the absence of `new Date()` in `lib/`.
4. **`activeConsents` silently drops unknown scope values** read from the DB
   (filtered through `CONSENT_SCOPES`). Correct for type safety, but if a scope
   is ever removed from the union, existing active rows become invisible to this
   function while still sitting in the table. Retiring a scope is therefore a
   migration, not an edit to the union — worth a note wherever scopes get added.
5. **The supersede window is not idempotent for a double-submit.** Two concurrent
   grants of the same scope now both try to withdraw-then-insert; one will hit
   the unique index and its whole transaction rolls back (correct, no bad data),
   surfacing as a 500 to the loser. A retry succeeds. If double-click matters at
   the route layer, that is where it should be absorbed.
6. **`withdrawConsent` writes N audit rows for N withdrawn rows.** With the index
   N is always 1, so this only differs on pre-index data. I preferred it to one
   row with a count because `entity_id` then actually identifies the row that
   changed, which Task 5's export needs.
7. **The brief's `pnpm test:int -- <name>` note is accurate** — the arg is
   ignored. For the forcing runs I used
   `pnpm exec vitest run --config vitest.integration.config.ts <file>`, which
   does filter. Worth adding to the harness notes; it turns a 51 s full run into
   a targeted one and made 7 forcing cycles affordable.
8. **`.superpowers/sdd/client-records/task-4-brief.md` is untracked** and was
   left that way, matching the earlier task briefs' handling in this branch.

### On the index question the brief asked me to raise

The owner decided it mid-task, so the recommendation is moot — but for the record
it is what I would have recommended, with the same pairing: the index **only**
alongside a defined re-grant semantic, because the index alone converts an
ordinary double grant into a 500. Between the two candidate semantics I would
have recommended supersede over return-the-existing-row for exactly the reason
given in the addendum: returning the existing row discards the new
`text_version`, and re-consent to updated wording is the event that most needs to
be on the record. The table was new and empty, so there was no backfill risk.
