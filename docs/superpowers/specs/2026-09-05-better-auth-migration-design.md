# Better Auth Migration — Design

**Date:** 2026-09-05
**Status:** Approved design, pending implementation plan
**Supersedes:** the auth line of `docs/superpowers/specs/2026-06-28-greek-dietitian-saas-design.md` (§2, "Database & auth" bullet) — that bullet named `@neondatabase/auth`, which this spec replaces.

## 1. Summary

Replace `@neondatabase/auth` (0.4.2-beta, a thin Neon-managed wrapper around
Better Auth) with plain `better-auth` (1.7.2, latest stable) + its Drizzle
adapter. This was a known follow-up logged in `.superpowers/sdd/progress.md`
after the client-records+GDPR module: *"`@neondatabase/auth` is BETA — pin
`<1.0.0`, upgrade to stable before go-live."*

Neon Auth previously owned the user/session/account schema externally. Once
we're on plain `better-auth`, the app owns that schema directly via Drizzle —
this is the one genuinely architectural piece of the change (new tables, a
new migration, a data-ownership decision), not just a dependency bump.

## 2. Goals / Non-goals

### Goals
- Drop the beta dependency; land on `better-auth`'s stable line before go-live.
- Preserve current behavior exactly: email+password only, no email
  verification, same Greek-language sign-in/sign-up UX and error strings,
  same `getCurrentUser(): Promise<{id,email}|null>` contract consumed by
  `lib/tenant.ts`'s `ensureTenantForUser` and its tests.
- Own the auth schema in a way consistent with how this repo already
  separates owner-pool access from tenant-scoped RLS access.

### Non-goals
- No new auth features (email verification, OAuth providers, magic links,
  password reset) — none exist today, none are being added here. Follow-ups.
- No change to the RLS/tenant model, `tenant_members`, or any
  tenant-scoped table.
- No data migration of existing users — the foundation module's own report
  notes live signup was never exercised headlessly, so there is no
  production user data to carry over.

## 3. Data ownership decision

better-auth needs four tables: `users`, `sessions`, `accounts`,
`verifications` (plural, matching this repo's existing naming convention —
`tenants`, `tenant_members`, `clients`, `client_consents`, `audit_log`).

**Decision: plain tables, no RLS.** They live in `db/schema.ts` without
`.enableRLS()`, and `authenticated_backend` (the tenant-scoped app role) gets
**no grants on them at all**. They are read/written exclusively through the
owner pool (`db/client.ts`'s `db`, the same connection migrations run
through) — never through `db/authed-client.ts`'s `authedDb`/`withUser`.

This mirrors the existing owner-vs-tenant-pool split rather than inventing a
new access pattern: these are infrastructure tables holding no tenant data
and no PII-per-client, so they don't belong in the RLS threat model that
`clients`/`client_consents`/`audit_log` were built for. Applying RLS to them
would also be circular — better-auth needs to read/write `users`/`sessions`
*before* any tenant relationship exists (that's what
`ensureTenantForUser` bootstraps afterward).

`tenant_members.userId` is already `text` (not `uuid`), which already
matches better-auth's default string user IDs — no schema change needed on
the tenant side.

## 4. Components

### `db/schema.ts` + new migration `0006_*`
Add `users`, `sessions`, `accounts`, `verifications` with better-auth's
standard field set:
- `users`: id (text, pk), email (text, unique), emailVerified (boolean),
  name (text), image (text, nullable), createdAt, updatedAt.
- `sessions`: id, userId (fk → users.id), token (unique), expiresAt,
  ipAddress, userAgent, createdAt, updatedAt.
- `accounts`: id, userId (fk → users.id), accountId, providerId,
  accessToken/refreshToken/idToken (nullable, for future OAuth), password
  (nullable, hashed — used by the email/password provider), createdAt,
  updatedAt.
- `verifications`: id, identifier, value, expiresAt, createdAt, updatedAt.

Shaped by hand to match this file's existing camelCase-JS/snake_case-column
style, cross-checked against `npx @better-auth/cli generate`'s own output
(pointed at the real `lib/auth/server.ts` config) so the column set isn't
guessed from memory. No `.enableRLS()`, no policies, no grants — see §3.

### `lib/auth/server.ts`
```ts
import { betterAuth } from 'better-auth'
import { nextCookies } from 'better-auth/next-js'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { db } from '@/db/client'
import * as schema from '@/db/schema'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema, usePlural: true }),
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,
  plugins: [nextCookies()], // must be last
})
```
`nextCookies()` is what lets `auth.api.*` calls from `'use server'` actions
set the session cookie without manual `Set-Cookie` plumbing.

### `lib/auth/client.ts`
```ts
'use client'
import { createAuthClient } from 'better-auth/react'
export const authClient = createAuthClient()
```
Currently unused elsewhere in the tree (sign-in/up go through server
actions calling `auth.api.*` directly) — kept at parity since the file
pre-exists for future client-side use (e.g. a sign-out button).

### `proxy.ts`
Swap `auth.middleware({loginUrl})` for better-auth's documented Next 16
pattern — an optimistic cookie-existence check, not full validation:
```ts
import { getSessionCookie } from 'better-auth/cookies'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export default function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL('/auth/sign-in', request.url))
  }
  return NextResponse.next()
}

export const config = { matcher: ['/dashboard/:path*'] }
```
Real validation still happens in `getCurrentUser()` (dashboard already
treats a null user as unauthenticated) — this is defense in depth, not a
weakening: a forged cookie gets past the proxy's fast check but fails
`auth.api.getSession`'s real lookup.

### `app/api/auth/[...path]/route.ts`
```ts
import { auth } from '@/lib/auth/server'
import { toNextJsHandler } from 'better-auth/next-js'
export const { GET, POST } = toNextJsHandler(auth)
```

### `lib/auth.ts` (`getCurrentUser`)
```ts
import { auth } from '@/lib/auth/server'
import { headers } from 'next/headers'

export async function getCurrentUser(): Promise<{ id: string; email: string } | null> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  return { id: session.user.id, email: session.user.email ?? '' }
}
```
External signature unchanged — `ensureTenantForUser` and its callers need
no changes.

### `app/auth/sign-in/actions.ts` / `sign-up/actions.ts`
better-auth's server-side `auth.api.*` **throws `APIError` on failure**
(unlike Neon Auth's wrapper, which returned `{error}`). Wrap in `try/catch`;
keep `redirect()` **outside** the `catch` so Next's internal redirect signal
isn't swallowed by a catch-all:
```ts
'use server'
import { auth } from '@/lib/auth/server'
import { APIError } from 'better-auth/api'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

export async function signInWithEmail(_prevState: { error: string } | null, formData: FormData) {
  try {
    await auth.api.signInEmail({
      body: {
        email: formData.get('email') as string,
        password: formData.get('password') as string,
      },
      headers: await headers(),
    })
  } catch (error) {
    if (error instanceof APIError) {
      return { error: error.message || 'Αποτυχία σύνδεσης. Δοκιμάστε ξανά.' }
    }
    throw error
  }
  redirect('/dashboard')
}
```
`sign-up/actions.ts` follows the same shape with `signUpEmail({ email, name,
password })` and the existing Greek fallback string.

### Env vars
`.env.example`: drop `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`; add
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`. These must also be set in Vercel
project env (preview + production) before deploy — not done as part of this
change since no Vercel CLI link exists in the working session; flagged as a
manual follow-up for whoever deploys next.

### `package.json`
Remove `@neondatabase/auth`. Add `better-auth@^1.7.2`,
`@better-auth/drizzle-adapter@^1.7.2`.

## 5. Testing

- `tests/unit/auth-helpers.test.ts`: remock `auth.api.getSession` instead of
  `auth.getSession`; same four cases (no session, no user, happy path, null
  email fallback).
- No new integration tests for better-auth's internals — it's a
  well-tested third-party library; we're not asserting new security
  properties the way RLS/audit/consent needed proving. The existing
  integration suite (`ensureTenantForUser`, RLS isolation) never touched
  Neon Auth directly and needs no changes.
- `typecheck` + `lint` + `pnpm test` + `pnpm test:e2e` must stay green, same
  as every prior task's exit gate.

## 6. Migration execution

`pnpm db:generate` (schema diff only, no live DB connection required) can
run in the implementation session. `pnpm db:migrate` requires
`DATABASE_URL` against the real Neon dev DB, which isn't available in the
sandboxed session — that command is handed to the user to run once the
migration file is generated and reviewed.

## 7. Open follow-ups (not in this change's scope)

Logged in `.superpowers/sdd/progress.md`, to be picked up next per user
priority (CI integration-test gate first):
1. CI integration-test gate — 117+ int tests still don't run in CI, blocked
   on Neon test-DB secrets (`chore/ci-integration-gate` branch exists,
   needs rebasing onto the recent pnpm/Node CI fixes).
2. `CHECK (scope IN (...))` on `client_consents.scope`.
3. Per-tenant `audit_log` reconciliation sweep for orphaned rows referencing
   erased clients.
4. Invoice/tax retention-policy slot for GDPR erasure (myDATA spike).
