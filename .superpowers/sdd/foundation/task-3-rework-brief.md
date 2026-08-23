# Rework: migrate auth from Stack Auth → Neon Auth API-only (Better Auth)

The project pivoted auth SDK. Task 3 was built on `@stackframe/stack` (Stack Auth).
We are switching to **Neon Auth API-only** (`@neondatabase/auth`, Better Auth under
the hood). Keep the `getCurrentUser()` interface stable so Task 4 (tenant bootstrap)
and the dashboard keep working unchanged.

**Authoritative doc (fetch it live and follow exactly):**
https://neon.com/docs/auth/quick-start/nextjs-api-only
The code below is from that doc; if the installed package differs, follow the
installed version and report deviations.

## Env (already set in `.env.local`; also update `.env.example`)
- `NEON_AUTH_BASE_URL` (set)
- `NEON_AUTH_COOKIE_SECRET` (set)
Remove the Stack vars from `.env.example` (`NEXT_PUBLIC_STACK_PROJECT_ID`,
`NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY`, `STACK_SECRET_SERVER_KEY`) and replace
with `NEON_AUTH_BASE_URL=` and `NEON_AUTH_COOKIE_SECRET=`.

## Remove (Stack Auth)
- `pnpm remove @stackframe/stack`
- Delete `stack.ts`
- Delete `app/handler/[...stack]/page.tsx` (and the `app/handler` dir if empty)
- Remove `StackProvider`/`StackTheme` wrapping from `app/layout.tsx` (keep
  `<Providers>` for PostHog and keep `lang="el"`).

## Add (Neon Auth / Better Auth)
- `pnpm add @neondatabase/auth`

`lib/auth/server.ts`:
```ts
import { createNeonAuth } from '@neondatabase/auth/next/server'

export const auth = createNeonAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
})
```

`lib/auth/client.ts`:
```ts
'use client'
import { createAuthClient } from '@neondatabase/auth/next'
export const authClient = createAuthClient()
```

`app/api/auth/[...path]/route.ts`:
```ts
import { auth } from '@/lib/auth/server'
export const { GET, POST } = auth.handler()
```

## Rewrite `lib/auth.ts` — KEEP THE SAME SIGNATURE
`getCurrentUser(): Promise<{ id: string; email: string } | null>` must stay
(Task 4's `lib/tenant.ts` and the dashboard depend on it). New body:
```ts
import { auth } from '@/lib/auth/server'

export async function getCurrentUser(): Promise<{ id: string; email: string } | null> {
  const { data: session } = await auth.getSession()
  if (!session?.user) return null
  return { id: session.user.id, email: session.user.email ?? '' }
}
```

## Middleware (protect /dashboard)
The doc shows `auth.middleware({ loginUrl: '/auth/sign-in' })`. Next.js 16 names
the file `proxy.ts` (the doc says `proxy.ts` for Next 16, `middleware.ts` for <16).
We are on Next 16 — VERIFY which the installed Next expects, use that file, and
REMOVE the old `middleware.ts` created in Task 4 if you create `proxy.ts`.
```ts
import { auth } from '@/lib/auth/server'
export default auth.middleware({ loginUrl: '/auth/sign-in' })
export const config = { matcher: ['/dashboard/:path*'] }
```

## Minimal sign-in / sign-up (Greek) — needed so the redirect target exists
Create `app/auth/sign-in/page.tsx` + `app/auth/sign-in/actions.ts` and
`app/auth/sign-up/page.tsx` + `app/auth/sign-up/actions.ts` following the doc's
server-action pattern (`auth.signUp.email` / `auth.signIn.email`), BUT:
- Labels/copy in **Greek** (e.g. "Σύνδεση", "Εγγραφή", "Email", "Κωδικός", "Όνομα").
- Use our existing Tailwind setup; keep it simple/clean (do NOT copy the doc's
  gray-900 demo styling verbatim — a plain accessible form is fine).
- On success, redirect to `/dashboard` (not `/`).

## Update the unit test `tests/unit/auth-helpers.test.ts`
It currently mocks `@/stack`. Rewrite to mock `@/lib/auth/server` (the `auth`
object with a `getSession` method) and assert `getCurrentUser`:
- returns null when `getSession()` resolves `{ data: null }` (or no user)
- maps `session.user.{id,email}` → `{ id, email }` when present
TDD: adjust the test (RED), then implement, then GREEN.

## Verify
- `pnpm test` (full unit suite GREEN — existing tenant-bootstrap/scrub/analytics tests must still pass).
- `pnpm typecheck` clean.
- Runtime live auth (actual signup against Neon) CAN now be attempted since
  NEON_AUTH_BASE_URL + COOKIE_SECRET are set — try `pnpm build` or a dev smoke if
  feasible; if the live auth endpoint can't be exercised headlessly, report what
  was and wasn't verified. Do NOT fake it.

## Commit
`git commit -m "refactor: migrate auth from Stack Auth to Neon Auth API-only (Better Auth)"`
(plus a `pnpm remove`/`pnpm add` lockfile change in the same or a prep commit).
