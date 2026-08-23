# Task 4 brief: `client_consents` + consent-service

Module: client-records+GDPR. Branch: `feat/client-records`, clean at `20c3f28`.
Plan: `docs/superpowers/plans/2026-06-28-client-records-gdpr.md` § "Task 4" (lines 660–856).
Spec: `docs/superpowers/specs/2026-06-28-client-records-gdpr-design.md` — the `client_consents` block (~lines 80–92) and §5 (services).

**Read both. This brief overrides the plan wherever they disagree — and they disagree on three substantive points.**

## Scope

- Modify: `db/schema.ts` (append `clientConsents`)
- Create: migration via `pnpm db:generate`, hand-edited to add FORCE
- Create: `lib/consents.ts`
- Create: `tests/integration/consents-rls.test.ts`

Out of scope: GDPR export/erase (Task 5), coverage tripwire (Task 6), routes, UI, indexes.

## Load-bearing facts — do not rabbit-hole

1. **NEVER nest `withUser` / `authedDb.transaction()` inside a `withUser` callback.** Fresh pooled connection, no `app.user_id` GUC, RLS sees an empty user, returns nothing — fail-closed but silently wrong, and it does not throw (`db/authed-client.ts:19-23`). `recordAudit(tx, args)` takes the live tx. Same for anything you factor out.
2. **ALL TIMESTAMPS COME FROM THE DB CLOCK.** Decided in Task 2, recorded in `progress.md`. The plan's `withdrawnAt: new Date()` **violates this — use `sql\`now()\``.** `lib/clients.ts` has the `dbNow` pattern to copy. Do not re-litigate.
3. **Foundation's `ALTER DEFAULT PRIVILEGES` grants `authenticated_backend` CRUD on new tables.** `client_consents` needs full CRUD (unlike `audit_log`), so **no REVOKE here**. A `permission denied` means the default-privileges path missed the table, not an RLS bug.
4. **`neondb_owner` has BYPASSRLS** — tests seed and reap through `db` (`db/client.ts`), assert through `withUser`.
5. **The PII denylist is broad**: `name|email|phone|afm|dob|birth|address|weight|height|bmi|body|medical|allergy|diagnos|note|client|patient`, case-insensitive, applied to metadata **keys**. `{ scope, withdrawn }` is safe; `{ clientId }` would throw. Client identity goes in the `client_id` column. Do not weaken `lib/pii-denylist.ts`.
6. **REAP AUDIT ROWS IN `afterAll`.** Consent operations write audit rows; `audit_log.tenant_id` has no FK and the request role has no DELETE grant, so only the owner path can reap them. Task 3 orphaned 237 rows before this was caught, and **it is invisible to all four verification gates.** The plan's `afterAll` omits `auditLog` entirely — add it, deleted first. Copy the `reap()` helper shape from `tests/integration/audit-append-only.test.ts:26`.
7. `pnpm test:int -- <name>` does not filter; the whole suite runs.
8. Reference implementations to match: `lib/clients.ts` (whitelist, `dbNow`, deny logging, membership resolution) and `lib/audit.ts`.

## Three plan defects you MUST fix

These are not style points. Verify each with a test.

### 1. Cross-tenant integrity hole in `grantConsent`

The plan inserts `{ tenantId: <caller's>, clientId: <argument>, … }` **without checking that the client belongs to the caller's tenant.** The FK to `clients.id` is satisfied by *any* existing client, and the RLS WITH CHECK only validates `tenant_id`, which is the caller's own. So a caller can attach a consent row in their own tenant referencing **another tenant's client id**.

Consequences: this tenant's table permanently holds a foreign client identifier (the exact thing the Task 3 `deny` decision was designed to avoid); the victim tenant cannot see or erase the row because RLS scopes it away; and their erasure `CASCADE` would silently delete a row belonging to someone else.

**Fix:** resolve the client under RLS first (`select … from clients where id = ? and deleted_at is null`). If it isn't reachable, write a `deny` audit row and do not insert. Test it: `grantConsent(userOther, victimClientId, …)` must not create a row, and a `deny` row must appear in the caller's tenant.

### 2. Withdrawal is not total — an unbalanced double grant survives it

`grantConsent` doesn't check for an already-active row, so granting the same scope twice yields two rows with `withdrawn_at is null`. The plan's `withdrawConsent` sets `withdrawn_at` on **only the latest** one, leaving the earlier row active forever.

Spec's "latest row wins" reading happens to give the right answer for *that* sequence, but the orphaned never-withdrawn row is still wrong: Task 5's export will show a dangling active consent, and GDPR withdrawal must be total.

**Fix:** `withdrawConsent` withdraws **every** active row for `(client_id, scope)`, not just the latest. Return `true` if any row changed. Test: grant twice, withdraw once, assert the scope is not active **and** that zero rows for that scope still have `withdrawn_at is null`.

### 3. `activeConsents` runs one query per scope, and ties are nondeterministic

Four sequential round trips inside one transaction, and `orderBy(desc(grantedAt)).limit(1)` is nondeterministic when two rows share `granted_at` (both come from `now()` = transaction start).

**Fix:** one query. Either `select distinct on (scope) … order by scope, granted_at desc, id desc`, or — simpler and order-independent once fix 2 makes withdrawal total — select the distinct scopes having at least one row with `withdrawn_at is null`. Take the second if you can defend it; say which you chose and why. Either way add `id desc` as a tiebreaker anywhere you order by `granted_at`.

## Also required

4. **Validate `scope` at runtime.** It's `text` in the DB with no CHECK, and `scope` arrives as a parameter — a value from parsed JSON reaching this service bypasses the TypeScript union entirely. Reject anything not in `SCOPES` before touching the DB. (Same defect class as Task 2's mass assignment; `lib/clients.ts` `NEW_CLIENT_KEYS` is the precedent.)
5. **Deny logging on the per-client paths — carried over from Task 3's owner decision.** `activeConsents` and `withdrawConsent` against an unreachable client must write a `deny` audit row: `action: 'deny'`, `entity: 'consent'`, `entityId: null`, `clientId: null`, `metadata: { outcome: 'denied' }`, attributed to the **caller's** tenant, **with no attempted id**. Copy `recordDeny` from `lib/clients.ts` — including the part where it **skips silently** for a membership-less caller rather than throwing. Throwing there was a real regression that had to be reverted from `listClients`; do not reintroduce it.
6. **`activeConsents` writes a `view` audit row** on success (`entity: 'consent'`, `clientId` set). Reading a client's consents is access to client data; spec §5 says the consent-service writes audit rows.
7. **Isolation tests — the plan has NONE**, despite naming the file `consents-rls.test.ts`. Add: another tenant cannot select this tenant's consent rows (with a positive control on its own row, or an empty result passes for the wrong reason); a cross-tenant insert with a foreign `tenant_id` is rejected by WITH CHECK (assert `/row-level security/i` via `tests/helpers/error-chain.ts`, never a bare `toThrow()`).
8. **Assert the table's RLS shape** the way Task 3 does: `pg_class.relrowsecurity` and `relforcerowsecurity` both true, and the policy present in `pg_policies`. Cast to `::text` so a driver returning `'f'` can't read as truthy.
9. **Consent lifecycle audit rows**: grant writes `create`, withdraw writes `update`, both `entity: 'consent'` with `clientId` set and `metadata: { scope }` / `{ scope, withdrawn: true }`. Assert them.

## Forcing-test discipline — mandatory

For defects 1 and 2, and for requirements 4, 5 and 8: **break the guard, prove the test goes red, restore, prove green. Paste both runs.** Task 2's review found a probe that passed with its protection removed — it was asserting something else. Task 3's `deny` work found the same. A test you have not seen fail is not evidence.

## TDD

RED first with **real pasted failure output**, then implement, then GREEN.

## Verification before you report

Run all four and paste output:
- `pnpm test:int` — green (58/58 currently)
- `pnpm test` — green (21/21)
- `pnpm typecheck` — clean
- `pnpm lint` — clean

Migration: generated SQL must contain `CREATE TABLE "client_consents"`, `ENABLE ROW LEVEL SECURITY`, your hand-added `FORCE ROW LEVEL SECURITY`, the FK to `clients(id) ON DELETE CASCADE`, and the isolation policy. `pnpm db:migrate` applies cleanly. Confirm the diff contains **only** the `client_consents` change.

**After a full `pnpm test:int` run, check for leftovers via the owner connection** — `select count(*) from audit_log`, `client_consents`, `clients`, `tenants` should all be 0 if the suite is the only writer. This is the check that catches the orphan-row class.

## Commit

Conventional Commits, subject ≤50 chars, body only where the "why" isn't obvious.
```
git add db/schema.ts db/migrations lib/consents.ts tests/integration/consents-rls.test.ts
```
Trailer: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## Report → `.superpowers/sdd/client-records/task-4-report.md`

What you implemented, RED/GREEN evidence, the forcing runs (broken + restored), files changed, self-review, and **concerns** — anything you assumed, worked around, or believe is wrong in the plan or in this brief. Say it plainly.

**Raise, do not implement:** whether `client_consents` should carry a partial unique index preventing two simultaneously-active rows for the same `(client_id, scope)` — a DB-level guarantee instead of the service-level fix in defect 2. Give a recommendation; it is a schema change and belongs to a decision, not this task.
