### Task 8: Deploy to Vercel (EU region) + CI gate

**Files:**
- Create: `.github/workflows/ci.yml`, `vercel.json`
- Modify: `README.md` (setup + testing + env docs)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a deployed EU-region app; CI running typecheck + lint + unit + E2E on every PR.

- [ ] **Step 1: Pin Vercel functions to EU**

`vercel.json`:
```json
{ "regions": ["fra1"] }
```

- [ ] **Step 2: Write CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm test:e2e
```
(Integration RLS tests run separately — they need live Neon + JWTs; document as a manual/secrets-gated job.)

- [ ] **Step 3: Connect Vercel + set EU env**

Manual: import the repo in Vercel, set all env vars (EU values), confirm the project region is `fra1`. Deploy.

- [ ] **Step 4: Verify the live smoke flow**

Run the Playwright smoke against the preview URL; manually sign up on the deployed app and confirm dashboard + tenant creation against Neon.

- [ ] **Step 5: Write README setup/testing/env section + commit**

Document: env vars, how to get the two test JWTs for RLS tests, EU-region requirement, the three test commands.
```bash
git add -A
git commit -m "ci: add EU-region Vercel deploy and CI pipeline"
```

---

## Self-Review

**Spec coverage (against §5 architecture + §5.4/§5.5 + §9):**
- Multi-tenant + RLS → Tasks 2, 4, 5 ✓
- Next.js + Vercel EU → Tasks 1, 8 ✓
- Neon + Drizzle → Task 2 ✓
- Neon Auth → Task 3 ✓
- Sentry (scrubbed) → Task 6 ✓
- PostHog (EU, masked) → Task 7 ✓
- Vitest + RTL → Task 1 ✓; Playwright → Tasks 1, 8 ✓
- RLS isolation test → Task 5 ✓; privacy regression → Tasks 6, 7 ✓
- **Not in this plan (correct — later module plans):** client records/GDPR consent, food DB, meal-plan builder, anthropometrics, scheduling, billing/myDATA. This plan is the foundation only.

**Placeholder scan:** No TBD/TODO; every code step has concrete code. The `notes` probe table is intentionally temporary and labeled as such.

**Type consistency:** `getCurrentUser` returns `{id,email}` (Task 3) and is consumed in Task 4 ✓. `ensureTenantForUser(userId, displayName)` defined Task 4, used in dashboard ✓. `authedDb(jwt)` defined Task 5 and used in tests ✓. `scrubEvent`/`assertSafeProps`/`capture` consistent across Tasks 6–7 ✓.

**Known execution risk:** exact Neon Auth + Drizzle RLS API names may have moved since Jan 2026; Task 5 Step 1 + Task 3 Step 1 mandate doc verification. This is the gated spike.
