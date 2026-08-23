# Task 6 Report: Sentry with PII/Health Scrubbing

## Files Created / Modified

| File | Action |
|------|--------|
| `instrumentation-client.ts` | Created — browser Sentry init (current SDK layout) |
| `sentry.server.config.ts` | Created — Node runtime Sentry init |
| `sentry.edge.config.ts` | Created — Edge runtime Sentry init |
| `instrumentation.ts` | Created — `register()` + `onRequestError` export |
| `app/global-error.tsx` | Created — App Router root error boundary |
| `lib/scrub.ts` | Created — `scrubEvent` PII scrubber |
| `tests/unit/scrub.test.ts` | Created — TDD regression test |
| `next.config.ts` | Modified — wrapped with `withSentryConfig` |
| `pnpm-workspace.yaml` | Modified — approved `@sentry/cli` build scripts |

## Config Layout Used

Current Sentry Next.js SDK layout per task-6-notes.md (NOT the older `sentry.client.config.ts`):
- `instrumentation-client.ts` for browser runtime
- `sentry.server.config.ts` / `sentry.edge.config.ts` for server/edge
- `instrumentation.ts` with `register()` + `export const onRequestError = Sentry.captureRequestError`
- `app/global-error.tsx` calling `Sentry.captureException`

## GDPR Override Confirmations (file:line)

| Requirement | Location |
|------------|----------|
| `sendDefaultPii: false` (client) | `instrumentation-client.ts:8` |
| `sendDefaultPii: false` (server) | `sentry.server.config.ts:8` |
| `sendDefaultPii: false` (edge) | `sentry.edge.config.ts:8` |
| NO `replayIntegration()` | Absent from all three inits (comment in `instrumentation-client.ts:12-14`) |
| `includeLocalVariables: false` (server) | `sentry.server.config.ts:11` |
| `beforeSend: scrubEvent` (client) | `instrumentation-client.ts:11` |
| `beforeSend: scrubEvent` (server) | `sentry.server.config.ts:14` |
| `beforeSend: scrubEvent` (edge) | `sentry.edge.config.ts:10` |
| `tracesSampleRate: 0.1` (all) | `instrumentation-client.ts:9`, `sentry.server.config.ts:9`, `sentry.edge.config.ts:9` |
| `silent: !process.env.CI` | `next.config.ts:16` |
| `authToken: process.env.SENTRY_AUTH_TOKEN` | `next.config.ts:14` |
| `org: process.env.SENTRY_ORG` | `next.config.ts:11` |
| `project: process.env.SENTRY_PROJECT` | `next.config.ts:12` |
| Replay tree-shaking (`bundleSizeOptimizations`) | `next.config.ts:18-21` |

## TDD RED/GREEN for Scrub

1. **RED**: Wrote `tests/unit/scrub.test.ts` before `lib/scrub.ts` existed.
   - Result: `Test Files 1 failed — @/lib/scrub not found` ✓ (confirmed FAIL)
2. **GREEN**: Implemented `lib/scrub.ts`.
   - Result: `Tests 2 passed (2)` ✓

## Typecheck / Test Results

- `pnpm typecheck`: PASS (no errors)
- `pnpm test`: PASS — 9 tests across 5 test files (includes the 2 new scrub tests)

## Deviations from Brief / Notes

1. **`treeshake` vs `bundleSizeOptimizations`**: The notes mention `treeshake` options on `withSentryConfig`, but `@sentry/nextjs@10.62.0` uses `bundleSizeOptimizations` (not `treeshake`) at the top level of `SentryBuildOptions`. Used `bundleSizeOptimizations.excludeReplayIframe` + `excludeReplayShadowDom` instead. Behaviour is identical — replay bundle code is tree-shaken.

2. **`captureRouterTransitionStart` not exported**: The notes mention `onRouterTransitionStart = Sentry.captureRouterTransitionStart` in `instrumentation-client.ts`. This symbol is not exported by `@sentry/nextjs@10.62.0`. Omitted to avoid a runtime error — no functional regression since App Router transition tracking is handled automatically.

3. **DENY regex — `note` key**: The brief's DENY regex includes `note`, but the regression test explicitly expects `note: 'ok'` to pass through unredacted. Removed `note` from the bare DENY list; compound keys like `medicalNote` are still caught by the `medical` pattern. The test is the authoritative spec.

4. **`pnpm-workspace.yaml`**: Required `@sentry/cli` build-script approval — set `allowBuilds['@sentry/cli']: true` in `pnpm-workspace.yaml` (was a placeholder requiring manual edit).

---

## Amendment: GDPR Code-Review Fixes (commit b761f5a)

### Changes Made

| File | Action |
|------|--------|
| `lib/pii-denylist.ts` | Created — shared `PII_DENY` regex + `isDenied()`. Single source of truth for scrub.ts and analytics.ts. |
| `lib/scrub.ts` | Updated — imports `PII_DENY` from `./pii-denylist`; removed local DENY definition; added `query_string` deletion, user stripping to `{ id }` only, and breadcrumbs clearing. |
| `tests/unit/scrub.test.ts` | Updated — `note` is now asserted as `[redacted]`; added assertions for `headers` removal, nested `contexts` redaction, `user` stripping, `query_string` deletion, and breadcrumbs clearing. Safe keys (`plan`, `step`) still asserted to pass through. |

### Policy Fix: `note` reinstated in denylist

`note` was wrongly omitted from `DENY` (deviation #3 in original report). It is now present in `PII_DENY` via `lib/pii-denylist.ts` and the corresponding test assertion changed to `expect(out.extra?.note).toBe('[redacted]')`.

### Verify Command Outputs

```
pnpm exec vitest run tests/unit/scrub.test.ts
  Test Files  1 passed (1)
      Tests  7 passed (7)

pnpm test
  Test Files  5 passed (5)
      Tests  14 passed (14)

pnpm typecheck
  (no errors)
```

### Commit

`b761f5a` fix: reinstate 'note' in PII denylist, share denylist, harden Sentry scrubber (review)

---

## Concerns

- No Sentry dashboard verification of EU data region (ingest.de.sentry.io) is possible without a working auth token and browser access — the DSN already points to `ingest.de.sentry.io` which is the EU region endpoint.
- `SENTRY_AUTH_TOKEN` is empty in `.env.local`, so source-map upload will no-op in dev. This is expected and acceptable.
- The `pnpm` field warning about `onlyBuiltDependencies` being ignored (from the `package.json` entry I added during install) is harmless noise — the actual approval is in `pnpm-workspace.yaml`.
