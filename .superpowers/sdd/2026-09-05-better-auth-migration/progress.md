# SDD ledger — plan: docs/superpowers/plans/2026-09-05-better-auth-migration.md

Branch: feat/better-auth-migration (plain feature branch off main, same
checkout — matches this repo's established convention from feat/client-records
and fix/consent-grant-race; no separate git worktree directory).
Baseline (before Task 1): typecheck clean, lint clean, 26/26 unit tests pass.

## Pre-flight conflict scan

| Pair | A produces | B consumes | Finding |
|---|---|---|---|
| Task1 → Task2 | `users`/`sessions`/`accounts`/`verifications` tables in `db/schema.ts` | `* as schema` for `drizzleAdapter(db, {schema,...})` | Consistent — Task2 imports the whole module, no per-table naming mismatch. |
| Task2 → Task3 | `auth` (betterAuth instance, `lib/auth/server.ts`) | `auth` for `toNextJsHandler(auth)` | Consistent. |
| Task2 → Task4 | `auth.api.getSession` | `getCurrentUser` calls `auth.api.getSession({headers})` | Consistent. |
| Task2 → Task6 | `auth.api.signInEmail` | sign-in action calls it with `{body,headers}` | Consistent. |
| Task2 → Task7 | `auth.api.signUpEmail` | sign-up action calls it with `{body,headers}` | Consistent. |
| Task2 → Task5 | (nothing — proxy.ts deliberately does NOT depend on Task2) | `getSessionCookie` imported directly from `better-auth/cookies` | Consistent — plan's own Task5 Interfaces section already calls this out as intentional (optimistic check, not full validation). |
| File overlap | Task1 touches `package.json` (dep swap) | No other task touches `package.json` | No overlap. |
| Global constraint: `getCurrentUser` signature unchanged | Task4's rewrite | `ensureTenantForUser`/dashboard (untouched) | Consistent — Task4 keeps `{id,email}` return shape verbatim. |
| Global constraint: no RLS on new tables | Task1's schema + migration | — | Consistent — no `.enableRLS()`/`pgPolicy` in Task1's code, and Task1 Step6 explicitly checks the generated migration for absence of `ENABLE ROW LEVEL SECURITY`. |
| Self-consistency: Task4's test vs Global Constraints | Test drops the old "session with no user" / "null email" cases | Constraint only requires the `{id,email}|null` *contract*, not identical test cases | No conflict — plan's own task text explains why (better-auth's `user.email` is non-nullable, so those states can't occur). |

Scan is clean. No rulings needed before Task 1.

## Tasks

Task 1: implementer done_with_concerns (commit e206fb0). Report:
task-1-report.md.
Task 1: minor (deferred): task-1-report.md's "Files Changed" list still
  names .mcp.json/.serena/ as changed — stale after the controller's
  untracking commit; harmless, the diff itself is correct.
Task 1: complete (commits b33de91..77b0c20, review clean — Approved).

Task 2: implementer (correctly) stopped and asked before assuming scope
  beyond the brief. My own dispatch message was wrong: I told it typecheck
  "should go... to fully green again" after this task — false. Task 1's
  failure was narrowly on the two files that couldn't even RESOLVE the
  removed `@neondatabase/auth` import. Once Task 2 fixes those two
  files' imports, TypeScript can finally type-check the real `betterAuth`
  instance's shape against every OTHER consumer (`proxy.ts`, `lib/auth.ts`,
  both sign-in/up actions, the API route) — and those call methods that
  don't exist on it (`auth.middleware`, `auth.getSession`, `auth.signIn`,
  `auth.signUp`, `auth.handler`), because they're the old wrapper's
  convenience API, not better-auth's. So typecheck errors don't disappear
  after Task 2, they MOVE to more files — exactly the files Tasks 3/4/6/7
  fix next, each closing its own file's error as it lands.
  Ruling: same reasoning as Task 1's ruling — the plan's "stay green"
  constraint binds the branch's state at Task 8, not every intermediate
  commit of a dependency-swap-then-consumer-fix split. Confirmed with the
  implementer: touch ONLY `lib/auth/server.ts` and `lib/auth/client.ts`
  per the brief, do not touch `proxy.ts`/`lib/auth.ts`/the actions/the
  route handler (Tasks 3/4/6/7's own scope, each with its own brief and
  tests), report DONE_WITH_CONCERNS noting the wider-but-still-expected
  typecheck gap. Cost if wrong: none — every one of those files is fixed
  by name in a task later in this same plan, dispatched next in sequence.
Task 2: minor (deferred): lib/auth/client.ts lost its trailing EOF newline
  in the rewrite — cosmetic, not caught by eslint, no functional effect.
Task 2: complete (commits 77b0c20..1c9c9d6, review clean — Approved;
  reviewer independently re-ran pnpm typecheck and confirmed the 11
  failures are confined to exactly the 6 expected files).
Task 3: complete (commits 1c9c9d6..22dc660, review clean — Approved).
Task 4: complete (commits 22dc660..d4e659b, review clean — Approved;
  reviewer independently checked mock shapes against the installed
  better-auth 1.7.2 type declarations, not just the brief's snippet).
Task 5: minor (deferred): tests/unit/proxy.test.ts has no
  beforeEach(vi.clearAllMocks()) — harmless with only 2 tests, could bite
  a future third test that forgets to set its own mock return value.
Task 5: complete (commits d4e659b..5c05678, review clean — Approved;
  reviewer independently reran pnpm test -- proxy and pnpm typecheck).
Task 6: minor (deferred): no test covers the non-APIError re-throw branch
  in sign-in/actions.ts — a gap the brief's own test list left uncovered,
  not an implementer deviation.
Task 6: complete (commits 5c05678..c5f24ed, review clean — Approved;
  reviewer independently verified the redirect/try-catch structural
  property by reading the code, not just trusting the report).
Task 7: complete (commits c5f24ed..5fa87de, review clean — Approved;
  reviewer independently confirmed pnpm typecheck is fully clean
  repo-wide, the exit criterion for all file-changing work in this plan).

Task 8: implementer done (commit 85d6037). Flagged (correctly, out of its
  own file scope) that README.md still had NEON_AUTH_BASE_URL/
  NEON_AUTH_COOKIE_SECRET in its env var table — the brief's grep check
  only excluded progress.md/docs/superpowers, not README. Fixed directly
  by the controller (mechanical, unambiguous, no design judgment) via
  follow-up commit 6ada23a — swapped the two table rows for
  BETTER_AUTH_SECRET/BETTER_AUTH_URL, nothing else touched.
Task 8: minor (deferred): the grep check's pathspec doesn't exclude
  `.superpowers/sdd/foundation/*.md` either — those carry stale
  NEON_AUTH_*/@neondatabase/auth references from an earlier (pre-this-plan)
  migration phase, unrelated to this work; "no output" was never
  achievable with that exact pathspec. Not a defect in this plan's diffs.
Task 8: complete (commits 5fa87de..6ada23a, review clean — Approved;
  reviewer independently re-ran the grep check and typecheck/lint/test).

ALL 8 TASKS COMPLETE. pnpm typecheck/lint/test/test:e2e all green at
6ada23a. Proceeding to final whole-branch review.

FINAL WHOLE-BRANCH REVIEW (opus, range 4c4ef1a..6ada23a): Ready to merge
WITH FIXES. One Critical finding, not caught by any per-task review
because no task's brief asked about it:
  CRITICAL: migration 0006 has no REVOKE for authenticated_backend on the
  four new tables. This repo's foundation set up ALTER DEFAULT PRIVILEGES
  so authenticated_backend automatically gets CRUD on every NEW table
  (documented in .superpowers/sdd/foundation/task-5-pathB-brief.md:9-10,
  already worked around once for audit_log via an explicit REVOKE in
  migration 0004). Task 1's spec/plan asserted "no grants at all" without
  accounting for this — a real defect in MY OWN spec, not the
  implementers'. Uncaught, applying 0006 would hand authenticated_backend
  — the role every tenant-scoped request uses — unrestricted, un-RLS'd
  CRUD on accounts.password (hashes) and sessions.token (session forgery
  primitive). Ruling: fix before merge (reviewer's own recommendation:
  "Blocking merge: Issue #1 only"). Dispatched one fix wave: (1) append
  REVOKE ALL to 0006 + correct the now-misleading db/schema.ts comment +
  add an integration test mirroring audit-append-only.test.ts's grant
  pattern (cannot verify it runs — no live DB in this sandbox, same
  constraint as db:migrate itself; user must run pnpm db:migrate then
  pnpm test:int to confirm live); (2) restore .superpowers/sdd/.gitignore
  to its original *.diff-only content (a stray git-add side effect from
  Task 1 had overwritten it to a bare `*`) and commit this plan's own
  brief/report files, matching the established precedent in
  foundation/ and client-records/ of tracking SDD artifacts permanently
  rather than treating them as disposable scratch — deviates from this
  skill version's default (delete the workspace at Finish); (3) add
  missing beforeEach(vi.clearAllMocks()) to proxy.test.ts; (4) add the
  untested non-APIError re-throw case to both sign-in and sign-up action
  tests (both files had the same gap, not just sign-in as first flagged).
  NOT fixed now (reviewer's own triage — follow-ups, not blockers):
  Important — no e2e test ever exercises real auth wiring (smoke.spec.ts
  only hits '/'); Important — progress.md's BETTER_AUTH_SECRET/URL
  handoff note undersold how severe missing it is (hard crash on every
  auth route in production, not a soft nice-to-have) — will strengthen
  the wording directly, no code change needed; Minor — English APIError
  text reaches the Greek UI on the fallback path (pre-existing shape,
  not a regression); Minor — bundle-size nit (better-auth/minimal vs
  full entry point); Minor — sign-up's crafted-POST NOT NULL 500 on a
  missing `name` (needs a product decision on validation + Greek
  message, not mine to make unilaterally); Minor — verifications
  table's nullable timestamps (matches plan text verbatim, harmless).

FIX WAVE (commits 6ada23a..64f3b0b): all 4 findings fixed in one dispatch
  (59b1a8f security revoke, 00bd52b gitignore+workspace-tracking restore,
  ddd94db test coverage, 64f3b0b fix-report itself tracked).
SCOPED RE-REVIEW: all 4 findings ADDRESSED, no new Critical/Important
  breakage. One out-of-scope observation: .superpowers/sdd/.gitignore
  kept reverting to `*` in the WORKING TREE (not the commits) every time
  `review-package`/`task-brief` ran, because both scripts call
  `sdd-workspace`, which unconditionally rewrites that file as a
  side effect on every invocation — a tooling behavior, not a defect in
  the fix. Restored one final time after the last review-package call
  (no more such calls remain for this plan) and verified clean against
  the committed state.
  Ruling: per my earlier ruling (Task 8), this plan's SDD workspace is
  tracked permanently, matching foundation/ and client-records/
  precedent — do NOT run the skill's default `rm -rf` at Finish.

BRANCH READY TO MERGE. All 8 tasks + 1 post-hoc fix wave complete and
reviewed clean. Handoff to user: (1) run `pnpm db:migrate` against the
real Neon dev DB to apply migration 0006 (now includes the REVOKE), then
`pnpm test:int` to confirm the new grants test passes live; (2) set
BETTER_AUTH_SECRET (high-entropy, 32+ chars) + BETTER_AUTH_URL in Vercel
env for preview/production BEFORE the next deploy — confirmed this is a
hard crash on every auth route without it, not a soft warning; (3)
manual smoke test once (2) is done: sign up -> land on /dashboard with a
tenant id -> clear session cookie -> confirm /dashboard bounces to
/auth/sign-in — no automated test exercises the real better-auth wiring
end-to-end (e2e/smoke.spec.ts only hits '/').
  Ruling: implementer's `git add` swept in two pre-existing untracked
  session-local files (.mcp.json, .serena/) plus this session's own
  `sdd-workspace` script side-effect (.superpowers/sdd/.gitignore: `*.diff`
  → `*`). Fixed directly (controller-level git hygiene, not a task-content
  finding) via follow-up commit 77b0c20 — `git rm --cached` on the two
  stray paths, restoring them to untracked. Kept the .gitignore's `*`
  change: it's the current skill's intended self-ignoring workspace
  pattern for `.superpowers/sdd/<plan-slug>/` and does not affect the
  separately-tracked flat `.superpowers/sdd/progress.md` this repo
  maintains (gitignore never hides an already-tracked path) — Task 8 still
  appends to and commits that file normally. Cost if wrong: none observed;
  net diff after the fix (b33de91..77b0c20) contains only the intended
  schema/migration/test/package.json/gitignore changes, verified via
  `git diff --stat`.
  Ruling: the implementer's report flags `pnpm typecheck` failing
  (lib/auth/{server,client}.ts still import the just-removed
  `@neondatabase/auth`) as expected, since this task's brief explicitly
  scopes out touching those files ("that's later tasks") and Task 2 fixes
  them immediately next. The plan's Global Constraint that typecheck must
  "stay green" is about the branch's state before merge/CI (Task 8's full
  verification gate), not an atomic per-commit invariant during a
  dependency-swap-then-consumer-fix migration split across two tasks by
  the plan's own design. Accepted — not a defect. Cost if wrong: none,
  since Task 2 (dispatched immediately after this ruling) closes the gap
  in the very next commit and nothing else reads this branch's
  intermediate commits.
