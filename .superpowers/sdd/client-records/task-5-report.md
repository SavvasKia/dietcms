# Task 5 report: GDPR export + erasure

Branch `feat/client-records`. Feature commit `764ff2e` — `feat: GDPR export + erasure service`.

## Files

- Create `lib/gdpr.ts` — `ClientExport`, `exportClient`, `eraseClient`.
- Create `tests/integration/gdpr.test.ts` — 18 tests, 5 describes.

No schema change, no migration, no change to `lib/pii-denylist.ts`.

## What was implemented

`exportClient(userId, clientId)` — one `withUser` transaction: select the client by
id with **no `deleted_at` filter**, then `client_consents` and `audit_log` filtered
by `client_id`, both read **directly** (never via `lib/consents.ts`, whose
`reachableClient` filters `deleted_at` and would return `[]` plus a spurious deny
row). Writes an `export` audit row with `entity_id`/`client_id` set — that row
legitimately references a client that still exists — plus PII-free counts
(`{ consents, auditRows }`). Unreachable → `deny` row, returns `null`.

`eraseClient(userId, clientId)` — the brief's corrected three-step order:

1. **Verify on the request path.** `withUser`, select by id (no `deleted_at`
   filter). Not reachable → `recordDeny`, return `false`. Then, and only then,
   resolve the caller's tenant from `tenant_members` with the **throwing**
   `callerTenantId`, not the `OrNull` variant: a `null` reaching the step-2
   predicate would compile to `tenant_id = NULL`, match zero rows, skip
   anonymization silently, and step 3 would still delete the client — a silent
   partial erasure through the exact statement this task exists to guard. A
   visible client implies a membership, so the throw cannot fire in practice; if
   it ever does it fires loudly *before* anything is destroyed.
2. **Anonymize `audit_log` on the owner connection**, `set { clientId: null,
   entityId: null, metadata: null }`, `where client_id = target AND tenant_id =
   callerTenantId`. Idempotent by construction.
3. **Delete the clinical rows on the request path** in one `withUser`
   transaction: `client_consents` explicitly (the FK cascades, but the per-table
   policy is stated in code), then `clients` with `.returning()`, then the final
   `erase` audit row. A zero-row delete throws (`erasure raced: …`) rather than
   returning `true`.

No `new Date()` anywhere; every timestamp is a column default (`now()`).

## RED → GREEN

RED (test file present, `lib/gdpr.ts` absent):

```
 ❯ tests/integration/gdpr.test.ts (0 test)
 FAIL  tests/integration/gdpr.test.ts [ tests/integration/gdpr.test.ts ]
Error: Cannot find module '../../lib/gdpr' imported from /home/skiaourt/extra/dietcms/tests/integration/gdpr.test.ts
 ❯ tests/integration/gdpr.test.ts:21:1
 Test Files  1 failed (1)
      Tests  no tests
```

GREEN after implementing:

```
 Test Files  1 passed (1)
      Tests  18 passed (18)
   Duration  26.09s
```

## Forcing runs

Each one: break the guard, run, restore from a byte-identical backup, re-run.
Restoration verified with `diff` (`RESTORED identical`) and the 18/18 green run
above is the post-restore run.

### F1 — requirement 1: remove `await recordDeny(tx)` from both entry points

```
     × a cross-tenant export returns null, denies, and discloses nothing 589ms
     × an unknown uuid returns null and denies 768ms
     × returns false, denies in the CALLER tenant, and deletes NOTHING 350ms
     × an unknown uuid returns false and denies 340ms
     × a second call returns false, does not throw, and only adds a deny row 320ms
AssertionError: expected [] to have a length of 1 but got +0
 Test Files  1 failed (1)
      Tests  5 failed | 13 passed (18)
```

### F2 — requirement 2: erase row carries `entityId: target.id, clientId: target.id`

```
     × writes a final erase row carrying NO client reference 61ms
AssertionError: expected 'dd0c9f8a-481f-4611-8f53-9120522ce546' to be null
 Test Files  1 failed (1)
      Tests  1 failed | 17 passed (18)
```

### F3 — requirement 3: drop the `tenant_id` predicate from the owner-path UPDATE

This is the run that proves the blast-radius test is real. `client_id` alone is a
globally unique uuid, so a `client_id`-only WHERE catches nothing **unless** a
foreign-tenant row carries the same `client_id`. The test seeds exactly that,
**through the request path**: `withUser(userB, tx => recordAudit(tx, { clientId:
erasedId, entityId: erasedId, … }))` passes `audit_log`'s WITH CHECK, because the
policy validates only `tenant_id` and `client_id` has no FK. The row is
constructible by a real caller, not a contrivance.

```
     × does NOT reach the second tenant's row that references the erased client 62ms
AssertionError: expected null to be '6b450a7c-6023-43bc-82c1-de1e620e20e0' // Object.is equality
    336|     expect(now, 'the cross-tenant reference row was deleted').toBeTrut…
 Test Files  1 failed (1)
      Tests  1 failed | 17 passed (18)
```

Without the predicate, an RLS-bypassing statement rewrote another tenant's audit
row. With it, that row is untouched.

### F5 — requirement 6: drop the `client_id` predicate (tenant-only WHERE)

```
     × leaves the sibling client in the SAME tenant completely untouched 65ms
AssertionError: expected [] to have a length of 3 but got +0
    302|     const after = await auditFor(tenantIdA, siblingId)
 Test Files  1 failed (1)
      Tests  1 failed | 17 passed (18)
```

The sibling client's three audit rows lost their `client_id` — the within-tenant
half of the blast radius.

### F4 — requirement 5: run step 1's reachability check on the OWNER connection

```
     × returns false, denies in the CALLER tenant, and deletes NOTHING 1079ms
     × a membership-less caller gets false, no throw, and no audit row 293ms
Error: erasure raced: client disappeared after the reachability check
Error: no tenant for user
 Test Files  1 failed (1)
      Tests  2 failed | 16 passed (18)
```

**Calibration — what this run does and does not prove.** It does *not* show the
victim's data being destroyed. Step 3's delete still runs under RLS and matches
zero rows, so the zero-row guard throws. What goes red is the contract: the
cross-tenant call rejects instead of returning `false`, and no deny row is
written (the client now "resolves", so `recordDeny` never runs); the
membership-less caller throws `no tenant for user` instead of returning `false`
silently. Step 2 also stayed harmless under the broken verification — its
predicate is `client_id = victim AND tenant_id = caller's`, which matches nothing
— so the two guards are independent and the tenant predicate held even with the
ownership proof sabotaged. Reported as a contract break, not as data loss.

## Verification

```
pnpm test:int   →  Test Files  5 passed (5)   Tests  117 passed (117)
pnpm test       →  Test Files  7 passed (7)   Tests   21 passed (21)
pnpm typecheck  →  $ tsc --noEmit          (no output)
pnpm lint       →  $ eslint .              (no output)
```

`test:int` went 99 → 117 (+18).

Leftover-row check via the owner connection after a full run:

```
audit_log=0 client_consents=0 clients=0 tenants=0 tenant_members=0
```

`reap()` deletes `audit_log` **first** in every `afterAll`, and additionally by
`actor_user_id` as well as by `tenant_id` — this file deliberately seeds a row in
one tenant referencing another tenant's client, and a tenant-scoped delete of the
*victim's* tenant cannot reach it.

## The retry-window trade (corrected ordering)

The plan deleted the clinical rows first, committed, then anonymized `audit_log`
as a separate owner statement, calling the crash window "acceptable for v1".
Spec §9 forbids it: *"on failure, surface and do not mark the client erased"* is
structurally unsatisfiable once the clinical delete has committed — at that
moment the client **is** erased, and no error handling can un-mark it.

With the corrected order the window moves and changes shape:

- **Crash between step 2 and step 3** → the client is still **present**, its
  audit rows are anonymized, and the operation is **retryable**: step 2 is
  idempotent (nulls columns that are already null) and step 3 completes on the
  retry. The observable state is "not yet erased", which is exactly what §9
  demands.
- **The cost**: a *permanently* failing erasure loses audit **detail**
  (`entity_id`, `metadata`) for a client that still exists. Retained: the row
  itself, `action`, `at`, `actor_user_id`, `tenant_id`. So the audit trail still
  answers "who did what, when, in which tenant" — it loses "to which record".
- Net: losing audit detail about a live client is recoverable (the client is
  still there to re-audit against); a client marked erased with clinical rows
  still on disk is not. The trade is the right way round.

Steps 1 and 3 are two **sequential** top-level `withUser` calls, never nested.
This is commented at the seam, because the obvious "improvement" is to merge them
for atomicity — which would either put the owner UPDATE inside a request
transaction (a second pooled connection with no `app.user_id` GUC) or push it
after the commit, i.e. straight back to the plan's broken order.

## Deviations, flagged

1. **Erase row keeps the real actor, not `system`** (spec §5 says "anonymized
   actor=system"). Taken deliberately per the brief. The acting user is the
   controller's staff, not the data subject; erasure does not cover them, and
   accountability for who ran an irreversible deletion is worth more than the
   pseudonym. `entity_id` and `client_id` **are** null, so the row carries no
   client PII — the part of §5 that is actually about the data subject holds.
2. **`exportClient` / `eraseClient` reach soft-deleted clients** — no
   `isNull(deletedAt)`, a deliberate departure from `lib/clients.ts` and
   `lib/consents.ts`, commented in `reachableClient` so it is not "fixed".
3. **Consents and audit rows read directly, not through `lib/consents.ts`** —
   `activeConsents` would return `[]` plus a deny row for a soft-deleted client,
   and it returns only *active* scopes, whereas an export owes the full consent
   history including withdrawals.
4. **Owner-path predicate uses the caller's `tenant_members` tenant, not
   `clients.tenant_id`.** Both are equal under the current clients policy, but
   the membership row is the value the caller cannot influence at all, so the
   BYPASSRLS statement's blast radius stays bounded by the caller's own tenant
   regardless of what that policy is later loosened to admit.
5. **A zero-row delete in step 3 throws** rather than returning `true`. Narrow
   race (concurrent erasure of the same client between step 1 and step 3), but
   the caller must never be told an erasure it did not perform succeeded.

## Concerns

1. **A foreign tenant's audit row referencing an erased client survives
   erasure.** Surfaced by F3 and now asserted as intended behaviour. Because
   `audit_log` has no FK on `client_id` and its WITH CHECK validates only
   `tenant_id`, any tenant can insert an audit row carrying another tenant's
   `client_id`, and a tenant-scoped anonymization cannot reach it. It survives
   holding a dangling uuid pointing at a client that no longer exists. This is
   the accepted trade — the alternative is an unbounded blast radius on a
   BYPASSRLS connection — and it is the same hazard `recordDeny`'s comment
   already anticipated when it decided not to record attempted ids. Residual
   risk is low: a bare uuid, with no name, email or clinical field attached. It
   is *not* fully closed, and this is the sharpest argument for the sweep in
   "Raise, do not implement" below.
2. **What an export cannot include, by construction.** List-view rows
   (`action='view'`, `entity_id=null`, `client_id=null`) and all `deny` rows
   carry `client_id = null` **by design**, so they are invisible to a
   client-scoped export. That is correct — neither identifies the data subject —
   but "every audit row about this client" is strictly narrower than "every audit
   row the tenant holds". Task 6's coverage tripwire proves each `client_id`
   table is *referenced* by both functions; it must not be read as promising
   that an export contains every audit row that ever concerned the client.
3. **The export audit row is not in its own dump** (written after the reads). A
   client who exports twice sees the first export recorded in the second dump.
   Intentional and self-consistent, but worth stating.
4. **Erasure is not atomic and cannot be.** The two request transactions plus the
   owner statement in between are three separate commits. This is forced by the
   `REVOKE UPDATE` on `audit_log`: the anonymization physically cannot join a
   request-path transaction. Documented rather than fixed.
5. **`metadata` is nulled wholesale on anonymization**, including PII-free
   payloads like `{ scope: 'email_comms' }` and `{ count: 3 }`. Consent-scope
   context is lost from the trail even though it identifies nobody. Selectively
   preserving keys would mean trusting the denylist on retained data forever;
   nulling the column is the conservative choice. Flagging it because the audit
   trail after an erasure is thinner than it strictly has to be.
6. **`clients.tenant_id` has no FK to `tenants`** (pre-existing, not introduced
   here) — noted only because erasure reasoning leans on tenant scoping
   throughout.
7. **No index on `audit_log.client_id`.** Both functions filter by it and the
   owner UPDATE scans on it. Explicitly out of scope per the brief; it will
   matter once the trail grows.

## Raise, do not implement

### Invoice / tax-retained tables (spec §5 policy slot)

Marked with a comment in `eraseClient`'s doc block naming the slot and the open
question, and nothing more — no retention rule invented. The open question, as I
read it: Greek tax law mandates retention that Art 17 cannot override, so which
**columns** of a retained invoice may stay identifying, and for how long? A
retained invoice that still carries name + AFM is not an erasure at all; one
stripped to a total and a date may not satisfy myDATA. That is a legal
determination, not a code one — it belongs to the myDATA retention spike, and the
billing module wires it in. There is no such table in the schema today, so
nothing is silently omitted right now; Task 6's tripwire will turn red the moment
a `client_id`-bearing invoice table lands, which is the correct forcing function.

**Recommendation:** leave it as a comment until the spike resolves. When it does,
the mechanism to reach for is a third per-table category — `retain-with-policy`
alongside `delete` and `anonymize` — so the coverage test can distinguish
"deliberately retained under a named legal obligation" from "silently
forgotten". Do not let a retained table default into the `anonymize` bucket.

### Reconciliation sweep

**Recommended, in two distinct halves — and they are not the same job.**

- **Half 1, per-tenant (closes the retry window).** For each tenant, find
  `audit_log` rows whose `client_id` matches no `clients` row *in that tenant*,
  and null `client_id` / `entity_id` / `metadata`. This is the same statement
  step 2 already runs, applied without a specific target, and it closes concern
  #1's *intra*-tenant case: a permanent step-3 failure, or an erasure interrupted
  after step 2, leaves the client present, so this half correctly leaves it
  alone; it only cleans up rows whose client is genuinely gone. Low risk, small,
  and the natural home is a scheduled job on the owner connection.
- **Half 2, cross-tenant (closes concern #1).** The surviving foreign-tenant row
  from F3 is *not* reachable by half 1 — within tenant B, `client_id` matches no
  `clients` row in tenant B, so half 1 would actually catch it, but only if the
  sweep's "no matching client" test is scoped per tenant rather than globally.
  Getting this right needs care in exactly the opposite direction: a **globally**
  scoped sweep (`client_id` matches no `clients` row in *any* tenant) would
  *miss* it while the referenced client still exists. So the sweep must be
  per-tenant scoped to be useful, and that is a decision worth making explicitly
  rather than falling into.
- **Do not** wire either into the request path. The value here is exactly that
  it runs on a schedule, on the owner connection, with no user waiting — and its
  own test can then assert the invariant directly ("no `audit_log` row references
  a `client_id` absent from its own tenant's `clients`"), which is a stronger
  statement than any single erasure test can make.

Build neither in this task; both are follow-ups, and half 1 is the cheap one that
earns its keep first.
