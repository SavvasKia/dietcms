# Task 6 Report: Sign-in Server Action

## Implementation Summary

Rewrote `app/auth/sign-in/actions.ts` to migrate from the old `@neondatabase/auth` wrapper pattern to `better-auth`'s `auth.api.signInEmail`, which throws `APIError` on failure instead of returning `{error}`.

### Files Changed
- **Modified**: `app/auth/sign-in/actions.ts`
- **Created**: `tests/unit/sign-in-action.test.ts`

## TDD Evidence

### Step 1: RED (Failing Tests)
```bash
pnpm test -- sign-in-action
```

**Output (before implementation)**:
```
 ❯ tests/unit/sign-in-action.test.ts (3 tests | 3 failed) 7ms
     × redirects to /dashboard on success 4ms
     × returns the APIError message and does not redirect on bad credentials 1ms
     × falls back to the Greek default message when the APIError has no message 1ms

TypeError: Cannot read properties of undefined (reading 'email')
 ❯ Module.signInWithEmail app/auth/sign-in/actions.ts:10:39
```

Reason: Old implementation called non-existent `auth.signIn.email(...)` and returned `{error}` instead of throwing.

---

### Step 2: GREEN (Passing Tests)
```bash
pnpm test -- sign-in-action
```

**Output (after implementation)**:
```
 Test Files  11 passed (11)
      Tests  34 passed (34)
   Start at  13:48:16
   Duration  2.33s
```

All 3 new test cases passing:
1. ✅ redirects to /dashboard on success
2. ✅ returns the APIError message and does not redirect on bad credentials
3. ✅ falls back to the Greek default message when the APIError has no message

---

## Type Safety Verification

### Before (with old sign-up still failing):
```bash
pnpm typecheck
```

Expected both sign-in and sign-up errors. Sign-in now fixed.

### After:
```bash
pnpm typecheck 2>&1 | grep -c "error TS"
```

**Result**: Only 1 error (sign-up/actions.ts, expected)

**typecheck output**:
```
app/auth/sign-up/actions.ts(16,32): error TS2339: Property 'signUp' does not exist on type 'Auth<...>'.
```

✅ `app/auth/sign-in/actions.ts` is now type-safe and clean.

---

## Implementation Details

### Key Changes

**Old pattern** (returning errors):
```ts
const { error } = await auth.signIn.email({...})
if (error) return { error: error.message || fallback }
redirect('/dashboard')
```

**New pattern** (throwing errors):
```ts
try {
  await auth.api.signInEmail({
    body: { email, password },
    headers: await headers(),
  })
} catch (error) {
  if (error instanceof APIError) {
    return { error: error.message || fallback }
  }
  throw error
}
redirect('/dashboard')
```

### Critical Placement: `redirect()` Outside Try/Catch

The `redirect('/dashboard')` call is intentionally placed **outside and after** the try/catch block because:
- Next.js's `redirect()` works by throwing an internal navigation signal
- If placed inside the try/catch, that signal would be caught by the catch block
- This would silently swallow the redirect, turning a successful sign-in into a no-op (user stays on sign-in page)
- By placing it after the try/catch, it only executes on the success path where no exception is thrown

**Verified in test**: The test mocks `redirect()` and confirms it's called only when `auth.api.signInEmail` succeeds.

---

## Commit Details

**Commit SHA**: c5f24ed  
**Branch**: feat/better-auth-migration

```bash
git log --oneline -1
c5f24ed feat: rewrite sign-in action on auth.api.signInEmail
```

### Git Status (Before Commit)
```
M  app/auth/sign-in/actions.ts
A  tests/unit/sign-in-action.test.ts
?? .mcp.json
?? .serena/
```

✅ Pre-existing untracked files (.mcp.json, .serena/) correctly left unstaged.

---

## Self-Review Findings

1. ✅ **redirect() placement**: Confirmed outside try/catch block — allows Next.js navigation signal to propagate correctly
2. ✅ **Error handling**: APIError caught and formatted with fallback Greek message
3. ✅ **Non-APIError propagation**: Other errors re-thrown (line 23: `throw error`)
4. ✅ **Headers passed**: `await headers()` correctly passed to `auth.api.signInEmail`
5. ✅ **Test coverage**: All three scenarios covered (success, APIError with message, APIError without message)
6. ✅ **No type errors**: typecheck output confirms sign-in/actions.ts is clean
7. ✅ **Staging discipline**: Only intended files staged, pre-existing untracked files left alone

---

## No Concerns

The implementation follows the brief exactly, with careful attention to the critical redirect() placement requirement.
