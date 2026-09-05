### Task 8: Env vars, cleanup, full verification, progress log

**Files:**
- Modify: `.env.example`
- Modify: `.superpowers/sdd/progress.md`

**Interfaces:** none — this task touches no code paths, only config/docs, and closes out the migration.

- [ ] **Step 1: Update `.env.example`**

Replace the Neon Auth block:

```
# Neon Auth (Better Auth)
NEON_AUTH_BASE_URL=
NEON_AUTH_COOKIE_SECRET=
```

with:

```
# Better Auth
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=
```

- [ ] **Step 2: Confirm no stray references remain**

```bash
git grep -n "NEON_AUTH_BASE_URL\|NEON_AUTH_COOKIE_SECRET\|@neondatabase/auth" -- . ':!.superpowers/sdd/progress.md' ':!docs/superpowers'
```

Expected: no output (progress.md and the design docs are historical records and deliberately keep the old names — everything else must be clean). If anything else shows up, fix it before continuing.

- [ ] **Step 3: Full verification**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

Expected: all green — this is the same gate CI runs on every push (`.github/workflows/ci.yml`).

- [ ] **Step 4: Log the migration in progress.md**

Append to `.superpowers/sdd/progress.md`:

```
=== better-auth migration (off @neondatabase/auth 0.4.2-beta) ===
Complete. Replaced the Neon-managed auth wrapper with plain better-auth@1.7.2
+ @better-auth/drizzle-adapter@1.7.2. App now owns users/sessions/accounts/
verifications directly (migration 0006) — plain tables, no RLS, no grants to
authenticated_backend, owner-pool only (db/client.ts). getCurrentUser's
{id,email}|null contract unchanged; ensureTenantForUser and the dashboard
needed zero edits. Sign-in/up actions moved from the wrapper's {error} return
shape to better-auth's real auth.api.signInEmail/signUpEmail, which throw
APIError instead — both now try/catch around the call with redirect() kept
outside the catch. proxy.ts simplified to better-auth's documented Next-16
pattern (getSessionCookie optimistic check; no auth.middleware() equivalent
exists in plain better-auth). PENDING (user, not done here): run
`pnpm db:migrate` against the real Neon dev DB (needs live DATABASE_URL, not
available in the planning/implementation sandbox); set BETTER_AUTH_SECRET +
BETTER_AUTH_URL in Vercel env for preview/production before next deploy.
```

- [ ] **Step 5: Commit**

```bash
git add .env.example .superpowers/sdd/progress.md
git commit -m "chore: finish better-auth migration — env vars, progress log

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WUuVy2RNrDfxWAVui9w2uc"
```

---

## After this plan

Hand back to the user:
1. Run `pnpm db:migrate` against the real Neon dev DB to apply migration 0006.
2. Set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` in Vercel env (preview + production).

Then move to the next backlog item per the user's stated priority: the CI integration-test gate (`.superpowers/sdd/progress.md`'s "CI HAD NEVER RUN" section + the stranded `chore/ci-integration-gate` branch).
