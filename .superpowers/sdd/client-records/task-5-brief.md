# Task 5 brief: GDPR export + erasure

Module: client-records+GDPR. Branch: `feat/client-records`, clean at `1e732a8`.
Plan: `docs/superpowers/plans/2026-06-28-client-records-gdpr.md` § "Task 5" (lines 856–1014) and § "Global Constraints" (lines 11–24).
Spec: `docs/superpowers/specs/2026-06-28-client-records-gdpr-design.md` §5 (gdpr-service), §7, §9 (error handling).

**Read all three. This brief overrides the plan where they disagree — including on the order of operations in `eraseClient`, which the plan gets structurally wrong.**

This is the highest-risk task in the module: it is the only one that destroys data, and the only one that writes through the RLS-bypassing owner connection on a request path. Treat every guard as load-bearing.

## Scope

- Create: `lib/gdpr.ts`
- Create: `tests/integration/gdpr.test.ts`

No schema change, no migration. Out of scope: the coverage tripwire (Task 6), routes, UI, indexes.

## Load-bearing facts — do not rabbit-hole

1. **NEVER nest `withUser` / `authedDb.transaction()` inside a `withUser` callback.** Fresh pooled connection, no `app.user_id` GUC, RLS sees an empty user, returns nothing — silently wrong, no throw (`db/authed-client.ts:19-23`).
2. **ALL TIMESTAMPS COME FROM THE DB CLOCK** (`sql\`now()\``). Decided Task 2. No `new Date()`.
3. **The request role has no UPDATE grant on `audit_log`** — that is the whole point of Task 3's `REVOKE`. Audit anonymization therefore *must* run on the owner connection (`db` from `db/client.ts`). Global Constraints sanction this as **the single request-path owner-write exception**. Do not widen it: the clinical deletes stay on the request path.
4. **The owner connection has BYPASSRLS.** Every owner-path statement must carry its own explicit `tenant_id` guard — RLS will not save you. See requirement 3 below.
5. **>>> TASK 4 HANDOFF: do NOT read consents through `lib/consents.ts`.** `reachableClient` filters `isNull(clients.deletedAt)` (`lib/consents.ts:71`), so a soft-deleted client is treated as *denied*: `activeConsents` returns `[]` **and writes a deny audit row**. Exporting a soft-deleted client through that path would return no consents and spam the audit trail. Query `client_consents` directly.
6. **`exportClient` and `eraseClient` must reach soft-deleted clients.** Do not add `isNull(clients.deletedAt)` to their lookups. A soft-deleted client's data still exists, and an erasure request is exactly what follows a soft delete. This is a deliberate departure from `lib/clients.ts`'s convention — comment it so it is not "fixed" later.
7. **The PII denylist applies to audit metadata keys** and is broad (`…|note|client|patient`). `{ clientId: … }` throws. Do not weaken `lib/pii-denylist.ts`.
8. **REAP `audit_log` FIRST in `afterAll`.** Task 3 orphaned 237 rows before this was caught, and it is invisible to all four verification gates. Copy the `reap()` shape from `tests/integration/audit-append-only.test.ts:26`.
9. `pnpm exec vitest run --config vitest.integration.config.ts <file>` **does** filter — use it for tight forcing loops. The `pnpm test:int -- <name>` form does not.
10. Reference implementations: `lib/clients.ts` (`recordDeny`, `callerTenantIdOrNull`, `dbNow`), `lib/consents.ts`, `lib/audit.ts`.

## The plan's ordering is structurally wrong — fix it

The plan deletes the clinical rows first (committing them), then anonymizes `audit_log` on the owner connection as a separate statement, and calls the crash window "acceptable for v1".

**Spec §9 forbids exactly that:** *"Partial-erasure must not leave clinical rows behind silently — on failure, surface and do not mark the client erased."* Once the clinical delete has committed, the client **is** erased; a subsequent anonymization failure cannot be un-marked. The plan's order cannot satisfy that sentence — no amount of error handling fixes it.

**Required order in `eraseClient`:**

1. **Verify reachability on the request path.** `withUser`, select the client by id (no `deleted_at` filter). Not reachable → write a `deny` audit row and return `false`. This is the RLS-backed ownership proof; everything after it depends on it.
2. **Anonymize `audit_log` on the owner connection**, scoped by **both** `client_id` **and** the caller's `tenant_id` (requirement 3). Idempotent by construction — re-running sets already-null columns to null.
3. **Delete the clinical rows on the request path**, in one `withUser` transaction: `client_consents` explicitly, then `clients`, then the final `erase` audit row (requirement 2).

Why this order: a crash between steps 2 and 3 leaves the client **present** and the operation **retryable** — step 2 is idempotent, step 3 completes on retry. The failure mode is "not yet erased", which is what spec §9 demands. The cost is that a permanently-failing erasure loses audit *detail* (`entity_id`, `metadata`) for a client that still exists, while retaining row, action, `at`, actor and tenant. State that trade in your report.

**If any step fails, surface it — throw. Never return `true` on a partial erasure.**

## Requirements

### 1. Deny logging on both entry points

Carried from Task 3's owner decision, now applied here. An unreachable client (wrong tenant, or nonexistent) must produce a `deny` audit row: `action: 'deny'`, `entity: 'client'`, `entityId: null`, `clientId: null`, `metadata: { outcome: 'denied' }`, attributed to the **caller's** tenant, **carrying no attempted id**. Copy `recordDeny` from `lib/clients.ts` — including that it **skips silently** when the caller has no membership rather than throwing. Throwing there was a real regression reverted from `listClients`; do not reintroduce it.

Applies to `exportClient` (returns `null`) and `eraseClient` (returns `false`).

### 2. The final `erase` audit row must carry NO client reference

Spec §5: *"Writes a final `erase` audit row (anonymized actor=system, no client PII)."*

Set `entityId: null`, `clientId: null`. Rationale beyond the spec: with the corrected ordering the erase row is written **after** anonymization, so a populated `client_id` would be a fresh dangling reference to the row you just deleted — reintroducing precisely what erasure removes.

**Deviation you should take, and must flag:** keep the **real** actor from the `app.user_id` GUC rather than `system`. The acting user is the controller's staff, not the data subject; erasure does not cover them, and accountability for who ran an erasure is worth more than the pseudonym. Say so in your report so the spec divergence is on the record.

### 3. The owner-path write must be tenant-scoped

The plan's `.where(eq(auditLog.clientId, clientId))` relies solely on uuid uniqueness. The owner connection bypasses RLS, so that is the one statement in this codebase with no structural guard at all. Add the caller's `tenant_id`:

```ts
.where(and(eq(auditLog.clientId, clientId), eq(auditLog.tenantId, callerTenantId)))
```

Resolve `callerTenantId` on the request path in step 1 and carry it forward. Test the blast radius explicitly (requirement 6).

### 4. Export shape and completeness

`ClientExport = { client, consents, auditLog }` per the plan. Query all three directly under `withUser` — `client_consents` filtered by `client_id`, `audit_log` filtered by `client_id`. Write an `export` audit row (`action: 'export'`, `clientId` set — this row legitimately references a client that still exists).

Note in your report which audit rows an export **cannot** include by construction: list-view rows and `deny` rows both carry `client_id = null` by design, so they are invisible to a client-scoped export. That is correct, not a bug, but Task 6's coverage tripwire should not be read as promising otherwise.

### 5. Tests the plan omits entirely — isolation on a destructive operation

The plan has **no** cross-tenant tests for either function. This is the module's only data-destroying path.

- Cross-tenant `exportClient` → `null`, a `deny` row in the **caller's** tenant, and nothing disclosed.
- **Cross-tenant `eraseClient` → `false`, a `deny` row, and NOTHING DELETED.** Assert via the owner connection that the victim's `clients` row, `client_consents` rows and `audit_log` rows are all still present and un-anonymized. This is the single most important assertion in the task.
- A membership-less caller: `null` / `false`, no throw, no audit row.

### 6. Blast-radius test for the owner-path anonymization

Seed **two** clients in the same tenant, both with consents and audit history, plus a client in a **second** tenant. Erase one. Assert:
- the erased client's audit rows have `client_id`, `entity_id`, `metadata` all null, and the rows still exist with `action`, `at`, `actor_user_id`, `tenant_id` intact;
- the **other client in the same tenant** has its audit rows completely untouched (all three columns still populated);
- the **second tenant's** rows are untouched;
- the erased client's `clients` and `client_consents` rows are gone.

### 7. Soft-deleted client path (Task 4 handoff)

Soft-delete a client via `softDeleteClient`, then:
- `exportClient` still returns the full record including its consents (proves you did not route through `lib/consents.ts` and did not add a `deleted_at` filter);
- `eraseClient` succeeds on it;
- neither writes a `deny` row for it.

### 8. Idempotence / second-call behavior

`eraseClient` on an already-erased client → `false` plus a `deny` row (the client no longer exists, so it is unreachable — same as any other miss). Assert it does not throw and does not re-anonymize anything.

## Forcing-test discipline — mandatory

For requirements 1, 2, 3, 5, 6: **break the guard, prove the test goes red, restore, prove green. Paste both runs.** Specifically, requirement 3's forcing run — drop the `tenant_id` predicate from the owner-path update and show a test catch it — is the one that proves the blast-radius test is real. Task 2's review found a probe that passed with its protection removed; Task 4's found another. A test you have not seen fail is not evidence.

## TDD

RED first with **real pasted failure output**, then implement, then GREEN.

## Verification before you report

Run all four and paste output:
- `pnpm test:int` — green (99/99 currently)
- `pnpm test` — green (21/21)
- `pnpm typecheck` — clean
- `pnpm lint` — clean

Then, via the owner connection, confirm zero leftovers: `audit_log`, `client_consents`, `clients`, `tenants`, `tenant_members` all 0 after a full run.

## Commit

Conventional Commits, subject ≤50 chars, body only where the "why" isn't obvious.
```
git add lib/gdpr.ts tests/integration/gdpr.test.ts
```
Trailer: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
Track the brief and report in a second `docs:` commit — that matches what tasks 1–4 did.

## Report → `.superpowers/sdd/client-records/task-5-report.md`

What you implemented, RED/GREEN evidence, every forcing run (broken + restored), files changed, self-review, and **concerns** — anything you assumed, worked around, or believe is wrong in the plan, the spec, or this brief. State the retry-window trade from the corrected ordering explicitly.

**Raise, do not implement:**
- The **invoice / tax-retained tables** slot. Spec §5 leaves it as a documented policy slot pending the myDATA retention spike. Put a comment in `lib/gdpr.ts` marking where it lands and what the open question is; do not invent a retention rule.
- Whether a **reconciliation sweep** (find `audit_log` rows whose `client_id` has no matching `clients` row) is worth adding later to close the retry window entirely. Recommend; do not build.
