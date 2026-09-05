### Task 2: Server + client auth instances

**Files:**
- Modify: `lib/auth/server.ts`
- Modify: `lib/auth/client.ts`

**Interfaces:**
- Consumes: `db` from `db/client.ts` (`export const db = drizzle(pool, {schema})`), `* as schema` from `db/schema.ts` (Task 1).
- Produces: `auth` — a `betterAuth(...)` instance exported from `lib/auth/server.ts`, with `auth.api.getSession`, `auth.api.signInEmail`, `auth.api.signUpEmail`, and `auth.handler` (used internally by `toNextJsHandler`). Consumed by Tasks 3, 4, 6, 7. `authClient` from `lib/auth/client.ts` — kept at parity, no current consumers.

There's no dedicated test for this task: it's third-party wiring, not new logic, and the spec (§5) explicitly scopes out asserting new security properties about better-auth's own internals. Correctness is verified by the manual check in Step 3 plus every downstream task's tests (Tasks 4/6/7 all exercise `auth.api.*` through mocks that assume this shape) and the final `pnpm typecheck` gate.

- [ ] **Step 1: Rewrite `lib/auth/server.ts`**

```ts
import { betterAuth } from 'better-auth'
import { nextCookies } from 'better-auth/next-js'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { db } from '@/db/client'
import * as schema from '@/db/schema'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema, usePlural: true }),
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  plugins: [nextCookies()], // must be last — see better-auth's Next.js docs
})
```

- [ ] **Step 2: Rewrite `lib/auth/client.ts`**

```ts
'use client'
import { createAuthClient } from 'better-auth/react'
export const authClient = createAuthClient()
```

- [ ] **Step 3: Note on missing env vars (no action needed here)**

CI has neither `BETTER_AUTH_SECRET` nor `BETTER_AUTH_URL` configured (same as the old `NEON_AUTH_*` vars never were), and `pnpm test:e2e` boots the dev server, which loads `proxy.ts` → this module at startup regardless of which route is hit. This was verified during planning in an isolated scratch script: constructing `betterAuth({ database: drizzleAdapter(...), plugins: [nextCookies()] })` with both `secret` and `baseURL` undefined logs `[Better Auth] Base URL is not set` and does **not** throw. So no fallback is needed — proceed to Step 4. Task 8's `pnpm test:e2e` run is the real end-to-end confirmation; if server boot ever fails there, the fix is `baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'` in this file.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (No test suite exists yet that imports the real module without mocking it — `tests/unit/auth-helpers.test.ts` still mocks the old shape at this point and gets fixed in Task 4.)

- [ ] **Step 5: Commit**

```bash
git add lib/auth/server.ts lib/auth/client.ts
git commit -m "feat: wire better-auth server + client instances

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WUuVy2RNrDfxWAVui9w2uc"
```

---

