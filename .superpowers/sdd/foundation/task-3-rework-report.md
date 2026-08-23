# Task 3 Rework Report: Stack Auth → Neon Auth API-only (Better Auth)

**Date:** 2026-06-28  
**Commit:** `77ae7bb` — refactor: migrate auth from Stack Auth to Neon Auth API-only (Better Auth)

---

## Files Removed
| File | Reason |
|---|---|
| `stack.ts` | Stack Auth server instance — replaced by `lib/auth/server.ts` |
| `app/handler/[...stack]/page.tsx` | Stack Auth dynamic route handler |
| `app/handler/[...stack]/` dir | Empty after deletion |
| `app/handler/` dir | Empty after deletion |
| `middleware.ts` | Stack-based middleware — replaced by `proxy.ts` (Next.js 16) |

---

## Files Added
| File | Purpose |
|---|---|
| `lib/auth/server.ts` | `createNeonAuth` server instance (`auth`) |
| `lib/auth/client.ts` | `createAuthClient` browser instance (`authClient`) |
| `app/api/auth/[...path]/route.ts` | Neon Auth API proxy handler (`GET`, `POST`) |
| `proxy.ts` | Route protection middleware (Next.js 16 naming), matcher `/dashboard/:path*`, loginUrl `/auth/sign-in` |
| `app/auth/sign-in/page.tsx` | Greek sign-in page (`Σύνδεση`) |
| `app/auth/sign-in/actions.ts` | Server action: `auth.signIn.email` → redirect `/dashboard` |
| `app/auth/sign-up/page.tsx` | Greek sign-up page (`Εγγραφή`) |
| `app/auth/sign-up/actions.ts` | Server action: `auth.signUp.email` → redirect `/dashboard` |

---

## Files Changed
| File | Change |
|---|---|
| `lib/auth.ts` | Body rewritten: `auth.getSession()` replaces `stackServerApp.getUser()`; **signature unchanged** |
| `app/layout.tsx` | Removed `StackProvider`/`StackTheme` wrapping; kept `<Providers>` (PostHog) and `lang="el"` |
| `app/(app)/dashboard/page.tsx` | Added `export const dynamic = 'force-dynamic'` to suppress cookie-read warning during static generation |
| `tests/unit/auth-helpers.test.ts` | Mocks `@/lib/auth/server` instead of `@/stack`; 4 test cases covering null, no-user, email mapping, null-email fallback |
| `.env.example` | Removed 3 Stack vars (`NEXT_PUBLIC_STACK_PROJECT_ID`, `NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY`, `STACK_SECRET_SERVER_KEY`); added `NEON_AUTH_BASE_URL=` and `NEON_AUTH_COOKIE_SECRET=` |
| `package.json` | Removed `@stackframe/stack`; added `@neondatabase/auth@0.4.2-beta` |
| `pnpm-lock.yaml` | Updated lockfile accordingly |

---

## API Deviations from Doc

**None.** The installed `@neondatabase/auth@0.4.2-beta` package exports exactly match the doc:
- `createNeonAuth` from `@neondatabase/auth/next/server` ✓
- `createAuthClient` from `@neondatabase/auth/next` ✓
- `auth.handler()`, `auth.middleware({ loginUrl })`, `auth.getSession()` ✓
- `auth.signIn.email()`, `auth.signUp.email()` ✓
- `proxy.ts` for Next.js 16+ (confirmed by doc) ✓

The `auth.middleware()` call in `proxy.ts` returns a function directly (not `export default function middleware()`), which is the correct Next.js 16 form as documented.

---

## TDD Evidence (auth-helpers)

**RED:** Original test mocked `@/stack` / `stackServerApp.getUser`. After rewriting the test to mock `@/lib/auth/server` / `auth.getSession`, but before rewriting `lib/auth.ts`, the test would fail (mock target mismatch).

**GREEN:** After rewriting both test and implementation together:
```
Test Files  6 passed (6)
     Tests  20 passed (20)
```
All 4 new auth-helpers cases pass:
1. Returns null when `{ data: null }` 
2. Returns null when `{ data: {} }` (no user key)
3. Maps `session.user.{id, email}` → `{ id, email }`
4. Falls back to `''` when `email` is null

All pre-existing tests (tenant-bootstrap, scrub, analytics, db-schema, smoke) remain green.

---

## Runtime Verification

### `pnpm typecheck` — CLEAN (no errors)

### `pnpm build` — SUCCEEDED (clean, no errors)

Build output (second run after adding `force-dynamic`):
```
✓ Compiled successfully in 9.0s
✓ Generating static pages (6/6)

Route (app)
├ ○ /
├ ○ /_not-found
├ ƒ /api/auth/[...path]     ← Neon Auth proxy mounted
├ ○ /auth/sign-in
├ ○ /auth/sign-up
└ ƒ /dashboard              ← Dynamic (server-rendered)

ƒ Proxy (Middleware)        ← proxy.ts recognized by Next.js 16
```

### Live Auth (actual Neon signup/signin)
Not exercised headlessly. `NEON_AUTH_BASE_URL` and `NEON_AUTH_COOKIE_SECRET` are set in `.env.local` and are consumed at build time without error, confirming the env vars are present and the SDK initialises. Actual sign-in/sign-up flows against the live Neon Auth endpoint were not tested in this session (would require a running `pnpm dev` and a browser).

---

## Concerns

1. **`@neondatabase/auth@0.4.2-beta`** — still in beta. The package is functional and types are complete, but a stable release may bring breaking changes.
2. **`proxy.ts` middleware file** — Next.js 16 uses `proxy.ts` instead of `middleware.ts`. This is confirmed by the live doc and the build output showing `ƒ Proxy (Middleware)`. If the project ever downgrades to Next.js <16, rename to `middleware.ts` with the wrapper function export form.
3. **Sentry `onRouterTransitionStart` warning** — pre-existing from Task 6, not introduced by this task.
