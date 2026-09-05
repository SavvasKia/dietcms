# Task 2 Report: Server + Client Auth Instances

## Summary
Successfully rewrote `lib/auth/server.ts` and `lib/auth/client.ts` to use `better-auth@1.7.2` instead of the removed `@neondatabase/auth` package.

## What Was Implemented

### lib/auth/server.ts
Replaced the Neon Auth wrapper with a `betterAuth` instance configured with:
- Drizzle adapter pointing to the `db` connection with `users/sessions/accounts/verifications` schema tables (from Task 1)
- Email+password authentication enabled
- Environment variables for secret and baseURL (unused in CI, per brief Step 3 verification)
- `nextCookies()` plugin as the last plugin in the array

### lib/auth/client.ts
Replaced the Neon Auth client import with `createAuthClient` from `better-auth/react`, keeping the same minimal export pattern.

## Files Changed
- `lib/auth/server.ts` — completely rewritten, 13 lines added/net +7 changes
- `lib/auth/client.ts` — import path swapped, 6 lines changed/net -1 changes

## Testing & Verification

### Typecheck Output
```
pnpm typecheck exit code: 1

Errors found in 5 consuming files (expected, per plan — fixed in Tasks 3/4/5/6/7):

app/api/auth/[...path]/route.ts (3 errors):
  - Property 'GET' does not exist on type 'Promise<Response>'
  - Property 'POST' does not exist on type 'Promise<Response>'
  - Expected 1 arguments for auth.handler(), got 0
  → Fixed by Task 3 (toNextJsHandler wrapper)

app/auth/sign-in/actions.ts (1 error):
  - Property 'signIn' does not exist on auth instance
  → Fixed by Task 6 (auth.api.signInEmail)

app/auth/sign-up/actions.ts (1 error):
  - Property 'signUp' does not exist on auth instance
  → Fixed by Task 7 (auth.api.signUpEmail)

lib/auth.ts (1 error):
  - Property 'getSession' does not exist on auth instance
  → Fixed by Task 4 (auth.api.getSession)

proxy.ts (1 error):
  - Property 'middleware' does not exist on auth instance
  → Fixed by Task 5 (getSessionCookie from better-auth/cookies)

tests/unit/auth-helpers.test.ts (4 errors):
  - Property 'getSession' does not exist on auth (mocked shape)
  → Fixed by Task 4 (test rewrite with new mock shape)
```

**Note:** These 11 errors across 5 files are by design and expected. They represent the API surface change from the old wrapper to plain better-auth, which will be resolved in Tasks 3–7. The key insight: `lib/auth/server.ts` and `lib/auth/client.ts` now compile correctly, allowing TypeScript to see the real `auth` shape and catch all downstream mismatches.

### No Direct Tests
Per brief: "There's no dedicated test for this task: it's third-party wiring, not new logic."

### Unit Test Status
`pnpm test` was not run (out of scope for Task 2 — tests in Tasks 3-7 will exercise the new auth shape through proper mocks).

## Git Status Before Commit
```
M  lib/auth/client.ts
M  lib/auth/server.ts
?? .mcp.json
?? .serena/
```
(Only the two auth files were staged; .mcp.json and .serena/ remain untracked, as intended.)

## Commit
```
1c9c9d6 feat: wire better-auth server + client instances
```

## Self-Review Findings

✅ **Completeness:** Both files match the brief's code exactly, including:
- Correct import order and structure
- `plugins: [nextCookies()]` as the LAST plugin
- Environment variables used as-is (no fallback added, per brief Step 3)
- No extra config (email+password only)

✅ **Discipline:** Only staged the two modified files via explicit `git add lib/auth/server.ts lib/auth/client.ts` — no broad-add forms used.

✅ **Design alignment:** 
- The auth instance exports the correct shape: `auth.api.getSession`, `auth.api.signInEmail`, `auth.api.signUpEmail`, and `auth.handler` (all referenced in Tasks 3/4/6/7).
- `authClient` from client.ts is kept minimal and matches better-auth's React usage pattern.

✅ **Transient state:** Typecheck failures in consuming files are expected and documented. Per the coordinator's clarification, this is the intended transient state: lib/auth files now compile, making their API mismatches visible to downstream files for Tasks 3–7 to fix.

## No Issues or Concerns
Task completed exactly as specified. All typecheck errors are confined to the five expected files (`app/api/auth/[...path]/route.ts`, `lib/auth.ts`, `app/auth/sign-in/actions.ts`, `app/auth/sign-up/actions.ts`, `proxy.ts`) and `tests/unit/auth-helpers.test.ts`, all of which are addressed by subsequent tasks.
