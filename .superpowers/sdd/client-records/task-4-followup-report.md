# Task 4 follow-up — concern triage

Branch `fix/consent-grant-race`, off `main` (`5ff5989`). NOT off
`chore/ci-integration-gate`, which is under a do-not-merge gate until the Neon
test secrets exist.

## Disposition of the seven Task 4 concerns

| # | Concern | Status |
|---|---|---|
| 1 | `grantConsent` returns `Consent \| null`, plan says otherwise | FIXED here (`30f4f69`) — plan's interface block corrected for all three as-built behaviours |
| 2 | Soft-deleted client unreachable → deny row (Task 5 trap) | ALREADY CLOSED by Task 5's design — `lib/gdpr.ts` reads `client_consents` directly and deliberately does not filter `deleted_at`, citing this exact reason |
| 3 | DB-clock rule unenforced | ALREADY DONE in `8b891bf` — an AST-based ESLint `no-restricted-syntax` rule on `lib/` and `db/`. Better than the source-text test I proposed: no false positives from comments/strings, reports the line, already runs in CI |
| 4 | `scope` has no DB CHECK | OPEN — schema decision, deliberately not landed. See recommendation below |
| 5 | Supersede double-submit → 23505 | FIXED here (`9513c6d`) |
| 6 | N audit rows per withdraw | No action, as intended |
| 7 | `test:int -- <name>` does not filter | ALREADY DONE in `8b891bf` — `test:int:file` script |

## Concern 5: the fix, and what the investigation turned up

`grantConsent` now resolves the client with `SELECT … FOR UPDATE` (opt-in via
`reachableClient(tx, clientId, { lock: true })`, so only the grant path locks).

Three findings, in the order they were forced out:

1. **The race is real, not theoretical.** A probe of two concurrent `withUser`
   transactions: distinct backends (pid 1071, 1072), both starting at +532ms and
   ending at +987ms. They genuinely overlap.
2. **Racing two real grants is not a usable gate.** Whether they collide depends
   on how ~5 round trips each interleave, so `Promise.allSettled` on two grants
   passed with the fix absent. That is a *timing-dependent* test, not a vacuous
   one — it can also fail in CI on an unlucky interleaving. Deleted rather than
   shipped.
3. **The obvious lock test was vacuous, and the FK is why.** A competing
   `FOR UPDATE` holder blocks the grant even with the fix reverted, because
   `client_consents.client_id`'s FK makes every consent INSERT take a
   `FOR KEY SHARE` lock on the parent client row, and `FOR UPDATE` conflicts with
   that. The discriminating holder is **`FOR NO KEY UPDATE`**: it conflicts with
   `FOR UPDATE` but is compatible with `FOR KEY SHARE`.

   The same matrix is why the FK does **not** already fix the race: two
   `FOR KEY SHARE` holders are compatible with *each other*, so two grants never
   serialise on it.

### Forcing evidence

| Break | Result |
|---|---|
| Fix absent (`.for('update')` not applied) | RED — `grantConsent finished while another transaction held the client row … expected true to be false` |
| Fix applied | GREEN — 43/43 |
| `{ lock: true }` wrongly added to `activeConsents` | RED — `activeConsents blocked on a client row lock: expected 1407 to be less than 600` |
| Reverted | GREEN — 43/43 |

Both new tests are therefore proven to fail when the thing they assert is wrong.

### Rejected alternative

`INSERT … ON CONFLICT (client_id, scope) WHERE withdrawn_at IS NULL DO UPDATE`
would be race-free in one statement, but it discards the history row the owner
explicitly chose in the supersede decision. Not a fix to make silently.

## Gates

`pnpm test:int` 119/119 (was 117, +2) · `pnpm test` 26/26 · `pnpm typecheck` clean
· `pnpm lint` clean. Owner-connection leftover check: all five tables 0.

## Open items for the owner

1. ~~**`8b891bf` is stranded.**~~ RESOLVED before this branch merged: cherry-picked
   onto `main` as `23c0a92`, so the ESLint DB-clock rule and `test:int:file` now
   reach `main` independently of the secrets gate. `chore/ci-integration-gate`
   remains correctly blocked, and note its CI trigger is `on: [push, pull_request]`
   — so *pushing* that branch (not only merging it) runs its integration job and
   goes red until `TEST_DATABASE_URL` / `TEST_DATABASE_URL_AUTHENTICATED` exist.
2. **Concern 4 — `CHECK (scope in (...))` on `client_consents.scope`.** Still
   recommended, still a schema decision. It would make `assertScope`
   defense-in-depth rather than the sole guard — the same pairing shape as the
   index and `withdrawConsent` — and would force scope retirement to be an
   explicit migration. Prefer a CHECK over a pg enum: extending a CHECK is a
   drop/add, whereas enum value ordering is painful.
3. **Shared CI database.** The integration job runs against a persistent shared
   DB, serialised by a concurrency group. The two tests added here hold a row lock
   for ~1.2s on their own freshly-created client, so they are safe under that
   model — but a future lock- or timing-based test must not assume exclusive
   access, and forcing tests (which break a guard) must never target it.
