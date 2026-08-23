# Task 5 (RLS spike) — Neon RLS + Drizzle + Better Auth notes

Updates the plan's Task 5 (which was written for Stack Auth). Mechanism confirmed
from https://neon.com/docs/guides/rls-drizzle.

## Drizzle RLS helpers
```ts
import { crudPolicy, authenticatedRole, authUid } from 'drizzle-orm/neon'
import { sql } from 'drizzle-orm'
```
- `auth.user_id()` (SQL) extracts the user id from the active JWT claims.
- `crudPolicy({ role: authenticatedRole, read: authUid(col), modify: authUid(col) })`
  is the convenience for USER-owned rows (row.userId == auth.user_id()).

## Our model is TENANT-owned, not user-owned
Rows carry `tenant_id`; a user maps to a tenant via `tenant_members`. So `authUid`
alone is wrong. Use a custom policy whose USING/WITH CHECK expresses tenant
membership:
```ts
using:     sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = auth.user_id() limit 1)`
withCheck: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = auth.user_id() limit 1)`
```
Keep `to: authenticatedRole` (or `to: 'authenticated'`). `.enableRLS()` on the table.
(The original Task 5 plan code is essentially correct — just confirm the role
helper import.)

## Authenticated DB client (passes the JWT so auth.user_id() resolves)
```ts
import { drizzle } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
export function authedDb(jwt: string) {
  const sql = neon(process.env.DATABASE_URL_AUTHENTICATED!, { authToken: jwt })
  return drizzle(sql)
}
```

## PREREQS (blocking — user/manual)
1. `DATABASE_URL_AUTHENTICATED` = connection string for the **`authenticated`**
   Postgres role (Neon Console → Connect → Role dropdown). Only exists if Neon RLS
   is enabled.
2. **Neon RLS / "Neon Authorize" must be enabled** for the project and pointed at
   the Neon Auth JWKS: `${NEON_AUTH_BASE_URL}/.well-known/jwks.json`. This is what
   makes `auth.user_id()` work and creates the `authenticated` role.

## OPEN QUESTION (the spike's real unknown)
How to obtain a Better Auth JWT to pass as `authToken` for the two test users
(`TEST_JWT_A/B`). Better Auth issues a session cookie; Neon RLS needs a JWT the
JWKS can verify. Need to find the Better Auth/Neon Auth method that yields that
JWT (e.g. an access-token / `getToken` on the session, or a Neon Auth-issued JWT).
Resolve via docs during the spike before writing the isolation test. If Neon Auth
doesn't expose a usable JWT for DB RLS, the isolation mechanism needs rethink —
this is exactly why Task 5 is a gated spike.
