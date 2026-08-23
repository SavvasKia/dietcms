# Task 3 brief: `audit_log` (append-only) + audit-service wired into client-service

Module: client-records+GDPR. Branch: `feat/client-records`, clean at `bf539d0`.
Plan: `docs/superpowers/plans/2026-06-28-client-records-gdpr.md` § "Task 3" (lines 405–660) — full implementation and baseline tests.
Spec: `docs/superpowers/specs/2026-06-28-client-records-gdpr-design.md` §4 (`audit_log`), §5 (services), §7 (test requirements).

**Read both. This brief closes gaps in the plan; it does not replace it.** Where this brief and the plan disagree, this brief wins.

## Scope

- Modify: `db/schema.ts` (append `auditLog`)
- Create: migration via `pnpm db:generate`, then hand-edit (FORCE + REVOKE)
- Create: `lib/audit.ts`
- Modify: `lib/clients.ts` (audit on all four mutations **and both read paths**)
- Create: `tests/integration/audit-append-only.test.ts`
- Create: `tests/helpers/error-chain.ts` (extract, see below)
- Modify: `tests/integration/clients-rls.test.ts` (import the extracted helper)

Out of scope: consents (Task 4), GDPR export/erase (Task 5), coverage tripwire (Task 6), UI/routes, any index.

## Load-bearing facts — do not rabbit-hole

1. **NEVER nest `withUser` / `authedDb.transaction()` inside a `withUser` callback.** A nested call takes a fresh pooled connection with no `app.user_id` GUC, so RLS sees an empty user and returns nothing — fail-closed but silently wrong, and it does not throw (`db/authed-client.ts:19-23`). This is why `recordAudit(tx, args)` takes the **live tx** as its first parameter. This is the single most important constraint in this task.
2. **DECISION ALREADY MADE — all timestamps come from the DB clock.** `at` uses `defaultNow()`; keep it. Do not introduce `new Date()` anywhere. Task 2's review fixed exactly this (`lib/clients.ts` uses `sql\`now()\``). Do not re-litigate.
3. **Foundation's `ALTER DEFAULT PRIVILEGES` grants `authenticated_backend` full CRUD on new tables.** That is *why* the REVOKE step exists — append-only is achieved by taking UPDATE/DELETE away after creation, not by withholding a grant. A `permission denied for table audit_log` on INSERT/SELECT means the default-privileges path missed the table; it is NOT an RLS model bug.
4. **`neondb_owner` has BYPASSRLS**, which is why tests seed and clean up through `db` (`db/client.ts`) despite FORCE RLS, and why Task 5's audit anonymization will use the owner path. Keep the owner-seed / `withUser`-assert split.
5. **The PII denylist regex is broad and will bite you.** `lib/pii-denylist.ts` matches `name|email|phone|afm|dob|birth|address|weight|height|bmi|body|medical|allergy|diagnos|note|client|patient` case-insensitively. So a metadata key of `clientId`, `noteCount`, or `patientRef` **throws**. Client identity belongs in the `client_id` **column**, never in `metadata`. Do not weaken the regex — it is shared with Sentry scrubbing and analytics guarding, and drift there is a GDPR defect.
6. `pnpm test:int -- <name>` does **not** filter — vitest ignores the argument and the whole integration suite runs. Expect all files' totals in the output. Don't chase it.

## Deliberate spec deviation to KEEP

Spec §4's `audit_log` has no `client_id` column; the plan adds one. **Keep the plan's `client_id`.** Task 5's erasure must find and anonymize audit rows referencing an erased client, and Task 6's coverage tripwire keys off client-scoped columns. Note this deviation in your report so it isn't "fixed" later.

## Plan gaps you MUST close

The plan's Task 3 is incomplete against the spec and repeats a defect class this branch has already fixed twice.

1. **`listClients` must write an audit row — the plan omits it entirely.** Spec §5: *"List views are audited as a single `view` with `entity='client'`, `entity_id=null`."* Wire it, and assert it. All six audited operations: `create`, `view` (read-one), `view` (list, `entityId=null`, `clientId=null`), `update`, `delete`.

2. **No bare `.rejects.toThrow()`.** The plan's UPDATE and DELETE append-only assertions are bare and will pass on a network blip, a syntax error, or a NOT NULL violation — i.e. they can go green while `audit_log` is fully writable. Extract the existing `errorChain()` helper out of `tests/integration/clients-rls.test.ts` into `tests/helpers/error-chain.ts`, import it in both files (neither vitest config collects a file without `.test.` in the name — verified), and assert `/permission denied/i` for the revoked UPDATE and DELETE.

3. **Assert the grants, not only the behavior.** Add a check that `information_schema.role_table_grants` shows `authenticated_backend` holding INSERT and SELECT on `audit_log` and **not** UPDATE or DELETE, and that `pg_class` shows `relrowsecurity` and `relforcerowsecurity` true. Behavior tests prove the current path; the grant assertion catches a future migration silently re-granting.

4. **Audit rows for every action, not just `create`.** The plan asserts only the create row. Assert one row per action for view-one, list, update, delete — with the right `entity`, `entityId`, `clientId`, and `actorUserId`. A missed wiring in Step 9 currently passes.

5. **Audit tenant isolation.** Another tenant must not see this tenant's audit rows. Same gap the plan had at Task 2. Seed two tenants, assert `withUser(userOther, …).select().from(auditLog)` excludes userA's rows and includes its own (positive control — otherwise an empty result passes for the wrong reason).

6. **PII denylist rejection test — required by spec §7** (*"Privacy regression: audit `metadata` rejects denylisted keys"*), absent from the plan. Prove `recordAudit` throws on a denylisted metadata key (match the real message via `errorChain`), and that a clean metadata key is accepted.

7. **Prove the mutation rolls back when the audit write fails.** The audit insert shares the mutation's transaction, so a failed audit must abort the mutation — no unaudited writes. Demonstrate it: drive `recordAudit` to throw inside a `withUser` transaction that has already inserted a client, then assert via the **owner** connection that no client row was persisted. This is the property that makes the audit trail trustworthy; state in your report how you triggered it.

8. **Type `recordAudit`'s tx parameter properly.** The plan writes `tx: any` and defines an `AuditTx` type it never uses. Task 2 established that `typeof authedDb` (imported from `@/db/authed-client`) is the correct type for a `withUser` callback tx. Use it; delete the dead `AuditTx`.

9. **Consider deduplicating the membership lookup.** `recordAudit` does its own `select from tenant_members` while `createClient` already resolved the same value via `callerTenantId(tx)` — two identical round trips per create. Optional: let `recordAudit` accept an optional pre-resolved `tenantId`. Do it or don't, but say which and why.

## Forcing-test discipline — mandatory

For requirements 2, 3, 6 and 7: **break the guard and prove the test fails.** Task 2's review found a probe that passed even with the protection removed — it was asserting something else entirely. Concretely, at minimum: comment out the `REVOKE` (or re-grant UPDATE/DELETE in a scratch statement), re-run, and confirm the append-only tests go red; then restore and confirm green. Paste both runs. A test you have not seen fail is not evidence.

## TDD

RED first, with **real pasted failure output**. Then implement. Then GREEN.

## Verification before you report

Run all four and paste output:
- `pnpm test:int` — green
- `pnpm test` — green (21/21 currently)
- `pnpm typecheck` — clean
- `pnpm lint` — clean

Migration checks: the generated SQL must contain `CREATE TABLE "audit_log"`, `ENABLE ROW LEVEL SECURITY`, your hand-added `FORCE ROW LEVEL SECURITY`, the `REVOKE UPDATE, DELETE`, and the isolation policy. `pnpm db:migrate` must apply cleanly. Confirm the migration diff contains **only** the `audit_log` change — no drift from other tables bundled in.

## Commit

Conventional Commits, subject ≤50 chars, body only where the "why" isn't obvious.
```
git add db/schema.ts db/migrations lib/audit.ts lib/clients.ts \
        tests/integration/audit-append-only.test.ts tests/helpers/error-chain.ts \
        tests/integration/clients-rls.test.ts
```
Trailer: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## Report → `.superpowers/sdd/client-records/task-3-report.md`

What you implemented, RED/GREEN evidence, the forcing-test runs (broken + restored), files changed, self-review, and **concerns**.

**Raise, do not implement — a spec question for the owner:** `getClient` writes a `view` row only when a row was actually returned, so a cross-tenant access *attempt* (RLS returns nothing) leaves no trace. For a clinical record system, denied access attempts are usually the ones you most want logged. The spec does not require it. Flag it in your report with a recommendation; do not build it in this task.
