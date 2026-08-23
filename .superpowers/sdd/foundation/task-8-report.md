# Task 8 Report: EU-Region Vercel Deploy + CI Gate

## Files Created / Modified

| File | Action |
|---|---|
| `vercel.json` | Created — pins Vercel serverless functions to `fra1` (Frankfurt) |
| `.github/workflows/ci.yml` | Created — Node 20 + pnpm CI: typecheck, lint, vitest, playwright E2E |
| `README.md` | Updated — env vars, EU-region note, test commands, manual Vercel steps, RLS test note |

## README Sections Added

- **Environment Variables** — table of all 7 required vars (`DATABASE_URL`, `DATABASE_URL_AUTHENTICATED`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`, `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`). Stack `pck_/ssk_/PROJECT_ID` vars intentionally omitted (auth pivoted to Neon Auth API-only / Better Auth).
- **EU-Region Requirement** — covers Neon, Vercel `fra1`, Sentry EU, PostHog EU ingest.
- **CI / Testing** — three test commands + playwright browser install note + RLS integration test caveat (secrets-gated, not in default CI).
- **Deploy on Vercel (Manual Steps)** — step-by-step for import, region pin, env vars, deploy, smoke test.

## Verify Output

- `pnpm typecheck`: PASS
- `pnpm lint`: FAIL (14 pre-existing `@typescript-eslint/no-explicit-any` errors in `app/providers.tsx`, `tests/unit/auth-helpers.test.ts`, `tests/unit/scrub.test.ts` — none in files touched by this task)
- `pnpm test`: PASS — 6 test files, 20 tests

## What Is Deferred to Manual Vercel Setup

1. Import the repository in the Vercel dashboard.
2. Set the Function Region to `fra1` in Project Settings > General.
3. Add all environment variables (EU-region values) in Project Settings > Environment Variables.
4. Trigger a deployment and run the Playwright smoke suite against the preview URL.
5. Manually verify sign-up + tenant creation against Neon.

## Commit

SHA: `dc8d107`
Subject: `ci: add EU-region Vercel deploy and CI pipeline`

---

# Task 8 Addendum: Resolve no-explicit-any lint errors so CI passes

## Problem

CI pipeline (added in previous commit) ran `pnpm lint` which failed with 14
`@typescript-eslint/no-explicit-any` errors across three files:
- `app/providers.tsx` (1 error)
- `tests/unit/auth-helpers.test.ts` (4 errors)
- `tests/unit/scrub.test.ts` (9 errors)

## Fixes Applied

### `app/providers.tsx`
Replaced `(posthog as any).__loaded` with the narrow two-step cast:
`(posthog as unknown as { __loaded?: boolean }).__loaded`
No runtime behavior change.

### `tests/unit/auth-helpers.test.ts`
Replaced `(auth.getSession as any).mockResolvedValue(...)` with the proper
Vitest pattern `vi.mocked(auth.getSession).mockResolvedValue(...)`. No ESLint
override needed — fully typed.

### `tests/unit/scrub.test.ts`
Introduced a local `fixture()` helper that converts `Partial<ErrorEvent>` to
`ErrorEvent` via `as unknown as ErrorEvent` — the minimal two-step cast
required because `ErrorEvent` has a required `type` field that test fixtures
don't need to set. The helper is contained within the test file and makes the
intent explicit. No blanket `any` disable.

No ESLint override added to the config — all fixes use proper types.

## Verify Output

- `pnpm lint`: PASS (0 errors, 0 warnings)
- `pnpm test`: PASS — 6 test files, 20 tests
- `pnpm typecheck`: PASS

## Commit

SHA: `f208d21`
Subject: `fix: resolve no-explicit-any lint errors so CI passes`
