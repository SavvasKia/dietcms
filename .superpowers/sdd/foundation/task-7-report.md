# Task 7 Report: PostHog (EU Cloud, input-masked) + Analytics Safety Guard

## Files Created / Modified

| File | Action |
|------|--------|
| `app/providers.tsx` | Created — PostHog client init + PostHogProvider wrapper |
| `lib/analytics.ts` | Created — `assertSafeProps` + `capture` |
| `tests/unit/analytics.test.ts` | Created — TDD test for `assertSafeProps` |
| `app/layout.tsx` | Modified — mounts `<Providers>` inside `<StackTheme>` |
| `pnpm-workspace.yaml` | Modified — set `core-js: true` (required for posthog-js install) |
| `pnpm-lock.yaml` / `package.json` | Modified — added `posthog-js@1.395.0` |

## analytics.ts imports isDenied from shared module (no local regex)

`lib/analytics.ts` line 2:
```ts
import { isDenied } from '@/lib/pii-denylist' // shared GDPR denylist (created in Task 6)
```
No local `DENY` regex defined. `PII_DENY` lives exclusively in `lib/pii-denylist.ts`.

## EU Host + Masking Options (app/providers.tsx)

| Option | Location | Value |
|--------|----------|-------|
| `api_host` | providers.tsx:9 | `process.env.NEXT_PUBLIC_POSTHOG_HOST` (https://eu.i.posthog.com) |
| `mask_all_text` | providers.tsx:11 | `true` |
| `mask_all_element_attributes` | providers.tsx:12 | `true` |
| `session_recording.maskAllInputs` | providers.tsx:13 | `true` |
| `session_recording.maskTextSelector` | providers.tsx:13 | `'*'` |
| `autocapture.dom_event_allowlist` | providers.tsx:10 | `['click']` |
| `person_profiles` | providers.tsx:14 | `'identified_only'` |

## TDD RED → GREEN

- **RED**: `pnpm exec vitest run tests/unit/analytics.test.ts` failed with `Cannot find module '@/lib/analytics'` — confirmed before implementation.
- **GREEN**: After creating `lib/analytics.ts` — 2/2 tests pass.

## Test Results

```
pnpm test (full suite): 6 test files, 16 tests — all passed
pnpm typecheck: clean (no errors)
```

## Concerns

- `posthog-js@1.395.0` required `core-js` build approval (`pnpm-workspace.yaml`). Set to `true`; this runs core-js polyfill postinstall (harmless, standard).
- `autocapture` in posthog-js v1.395.0 accepts an object with `dom_event_allowlist`; this matches the brief's intent (restrict to click events only).
- The `<Providers>` component uses `useEffect` for init, so PostHog only initialises client-side — correct for Next.js App Router (no SSR leak).

## Commit

SHA: `910b306` — `feat: add PostHog (EU, input-masked) with analytics safety guard`

---

## Review Fixes (2026-06-28)

### Fix 1: Test capture guard path through `capture()`
Added two new tests in `tests/unit/analytics.test.ts` using `vi.mock('posthog-js', ...)`:
- `capture('evt', { weight: 70 })` throws `/denylisted prop/` AND `posthog.capture` is NOT called (GDPR guard verified end-to-end)
- `capture('evt', { plan: 'pro' })` calls `posthog.capture` exactly once with matching args

### Fix 2: Guard against double-init in `app/providers.tsx`
Wrapped `posthog.init(...)` with `if (!(posthog as any).__loaded)`. All existing init options unchanged.

### Fix 3: Annotated `core-js` approval in `pnpm-workspace.yaml`
Added inline comment: `# posthog-js polyfill postinstall`

### Verify Output

```
pnpm exec vitest run tests/unit/analytics.test.ts
  Test Files  1 passed (1)
  Tests       4 passed (4)

pnpm test (full suite)
  Test Files  6 passed (6)
  Tests       18 passed (18)

pnpm typecheck: clean (no errors)
```

### Commit

SHA: `5290f52` — `fix: test capture guard path, guard PostHog double-init, annotate core-js approval (review)`
