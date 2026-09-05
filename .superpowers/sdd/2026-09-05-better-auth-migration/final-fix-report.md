# Final Fix Wave Report — better-auth migration post-hoc review

Branch: `feat/better-auth-migration`. All four fixes from the final whole-branch
review applied and verified. No subagents were dispatched; all work done directly.

## Fix 1 — CRITICAL security: missing REVOKE on new auth tables

- **1a.** Appended to `db/migrations/0006_futuristic_arclight.sql`:
  ```sql
  --> statement-breakpoint
  REVOKE ALL ON "accounts", "sessions", "users", "verifications" FROM "authenticated_backend";
  ```
  Verified the file's existing content first (it matched the task description
  exactly — 4 `CREATE TABLE` statements + 2 FK `ALTER TABLE` statements, no
  existing REVOKE) before appending.

- **1b.** Replaced the comment block above `export const users = pgTable(...)`
  in `db/schema.ts` with the exact text specified in the brief, explaining the
  REVOKE requirement and referencing migration 0004's precedent.

- **1c.** Created `tests/integration/auth-tables-privileges.test.ts`, mirroring
  `tests/integration/audit-append-only.test.ts` lines 49-62's grant-introspection
  pattern (`information_schema.role_table_grants`), parametrized over all four
  tables via `it.each`, asserting zero grants (not INSERT+SELECT, since these
  tables get no grants at all).

### Integration test — live verification status: COULD NOT VERIFY (no live DB, expected)

Exact command run:
```
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/auth-tables-privileges.test.ts
```

Exact output (relevant excerpt, all 4 parametrized cases failed identically):
```
Error: No database host or connection string was set, and key parameters have default values (host: localhost, user: skiaourt, db: skiaourt, password: null). Is an environment variable missing? Alternatively, if you intended to connect with these parameters, please set the host to 'localhost' explicitly.
 ❯ kn.connect node_modules/.pnpm/@neondatabase+serverless@1.1.0/.../index.mjs:1316:50
 ...
 Test Files  1 failed (1)
      Tests  4 failed (4)
```

This is a pure connection failure (no `DATABASE_URL`/`DATABASE_URL_AUTHENTICATED`
available in this sandbox) — not a syntax or logic error in the test itself. This
matches the expected/documented constraint: this migration's own Task 1 already
deferred `pnpm db:migrate` for the same reason, and migration 0006 has never been
applied to a live database in this environment.

**The user must run `pnpm db:migrate` then `pnpm test:int` (or the file-scoped
command above) against a real Neon DB to confirm the migration's REVOKE and this
test actually work together.**

`pnpm typecheck` and `pnpm lint` were run against the new test file (as part of
the full-repo runs below) and both pass — no syntax/type issues.

## Fix 2 — restore `.superpowers/sdd/.gitignore`, commit SDD workspace files

- **2a.** Confirmed via `git log -p -1 -- .superpowers/sdd/.gitignore` that the
  file had been changed from the two-comment-lines + `*.diff` original to a bare
  `*` in commit `e206fb0`. Restored the exact original content:
  ```
  # Track briefs, reports and progress.md — the only durable record of SDD task state.
  # Review diffs are regenerable from git and run to hundreds of KB; keep them local.
  *.diff
  ```

- **2b.** After restoring the gitignore, `git add .superpowers/sdd/.gitignore
  .superpowers/sdd/2026-09-05-better-auth-migration/` picked up exactly the 17
  brief/report/progress.md files (task-1 through task-8 briefs+reports, plus
  progress.md) and automatically skipped all 10 `review-*.diff` files present in
  that directory — confirmed via `git status --porcelain` before committing (no
  `.diff` path appeared in the staged list).

## Fix 3 — `tests/unit/proxy.test.ts` missing `beforeEach(vi.clearAllMocks())`

Added `beforeEach` to the vitest import and added `beforeEach(() => vi.clearAllMocks())`
as the first line inside the `describe('proxy', ...)` block, matching the pattern
already present in `sign-in-action.test.ts` and `sign-up-action.test.ts`.

## Fix 4 — untested non-APIError re-throw branch in sign-in/sign-up actions

Added the exact test case specified in the brief to both
`tests/unit/sign-in-action.test.ts` and `tests/unit/sign-up-action.test.ts`,
proving `auth.api.signInEmail`/`signUpEmail` rejecting with a plain `Error`
(not `APIError`) propagates out of the action (via `.rejects.toThrow`) and does
not call `redirect`.

## Verification (full repo, after all four fixes)

### `pnpm typecheck`
```
$ tsc --noEmit
```
Exit clean, no output — PASS.

### `pnpm lint`
```
$ eslint .
```
Exit clean, no output — PASS.

### `pnpm test` (unit)
```
$ vitest run
 Test Files  12 passed (12)
      Tests  39 passed (39)
   Start at  14:17:55
   Duration  2.73s
```
PASS — all 39 unit tests across 12 files green, including the new/modified
cases from Fix 3 and Fix 4.

`pnpm test:e2e` and `pnpm db:migrate` were deliberately NOT run, per explicit
instruction (e2e already verified green and unrelated to these fixes; no live
DB available for migrate).

## Commits created

Three commits, each with an exact, intentional file list (verified via
`git status --porcelain` immediately before each `git add` and again after
staging, before each commit):

1. **`59b1a8f`** — `fix(security): revoke authenticated_backend grants on better-auth tables`
   - `db/migrations/0006_futuristic_arclight.sql` (modified)
   - `db/schema.ts` (modified)
   - `tests/integration/auth-tables-privileges.test.ts` (new)

2. **`00bd52b`** — `docs: restore SDD .gitignore and track better-auth-migration task trail`
   - `.superpowers/sdd/.gitignore` (modified)
   - `.superpowers/sdd/2026-09-05-better-auth-migration/progress.md` (new)
   - `.superpowers/sdd/2026-09-05-better-auth-migration/task-{1..8}-brief.md` (new, 8 files)
   - `.superpowers/sdd/2026-09-05-better-auth-migration/task-{1..8}-report.md` (new, 8 files)
   - (18 files total; no `.diff` file staged — confirmed by `git status --porcelain` before commit)

3. **`ddd94db`** — `test: add mock isolation and error re-throw coverage for auth actions`
   - `tests/unit/proxy.test.ts` (modified)
   - `tests/unit/sign-in-action.test.ts` (modified)
   - `tests/unit/sign-up-action.test.ts` (modified)

### `git status` before each commit

Before commit 1 (after `git add db/migrations/0006_futuristic_arclight.sql
db/schema.ts tests/integration/auth-tables-privileges.test.ts`):
```
 M .superpowers/sdd/.gitignore
M  db/migrations/0006_futuristic_arclight.sql
M  db/schema.ts
A  tests/integration/auth-tables-privileges.test.ts
 M tests/unit/proxy.test.ts
 M tests/unit/sign-in-action.test.ts
 M tests/unit/sign-up-action.test.ts
?? .mcp.json
?? .serena/
?? .superpowers/sdd/2026-09-05-better-auth-migration/
```
(only the three intended paths show as staged — `M `/`A ` in the left column;
everything else correctly unstaged or untracked)

Before commit 2 (after `git add .superpowers/sdd/.gitignore
.superpowers/sdd/2026-09-05-better-auth-migration/`):
```
M  .superpowers/sdd/.gitignore
A  .superpowers/sdd/2026-09-05-better-auth-migration/progress.md
A  .superpowers/sdd/2026-09-05-better-auth-migration/task-1-brief.md
... (17 task brief/report files total, all "A ")
 M tests/unit/proxy.test.ts
 M tests/unit/sign-in-action.test.ts
 M tests/unit/sign-up-action.test.ts
?? .mcp.json
?? .serena/
```
No `.diff` path anywhere in the staged list — verified.

Before commit 3 (after `git add tests/unit/proxy.test.ts
tests/unit/sign-in-action.test.ts tests/unit/sign-up-action.test.ts`):
```
M  tests/unit/proxy.test.ts
M  tests/unit/sign-in-action.test.ts
M  tests/unit/sign-up-action.test.ts
?? .mcp.json
?? .serena/
```

Final `git status --porcelain` after all commits:
```
?? .mcp.json
?? .serena/
```
Clean — only the pre-existing, intentionally-untracked files remain.

## Concerns

- Fix 1's integration test is unverified against a live database (as expected
  and flagged above) — this is the one open item requiring the user's action:
  run `pnpm db:migrate` against the real Neon DB, then `pnpm test:int` (or the
  file-scoped command in this report) to confirm the REVOKE statement and the
  new test actually agree once the migration is applied.
- No other concerns. All file contents matched the brief's descriptions exactly
  before editing (migration 0006's existing content, schema.ts's existing
  comment, the gitignore's original content via git history, and the existing
  test file patterns) — nothing required deviating from the brief.
