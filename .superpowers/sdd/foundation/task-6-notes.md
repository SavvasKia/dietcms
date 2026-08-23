# Task 6 (Sentry) — reconciled config notes

Use the CURRENT Sentry Next.js SDK file structure (from skills.sentry.dev),
NOT the older `sentry.client.config.ts` layout in the plan. But OVERRIDE
Sentry's privacy-hostile defaults — this is a health-data app (GDPR special
category). The scrubber + regression test from the plan's Task 6 still apply.

## File structure (current SDK)
- `instrumentation-client.ts` — browser runtime (replaces `sentry.client.config.ts`)
- `sentry.server.config.ts` — node runtime
- `sentry.edge.config.ts` — edge runtime
- `instrumentation.ts` — `register()` + `export const onRequestError = Sentry.captureRequestError`
- `app/global-error.tsx` — error boundary that calls `Sentry.captureException`
- wrap `next.config.ts` with `withSentryConfig(...)`

## MANDATORY overrides of Sentry defaults (GDPR)
- `sendDefaultPii: false` everywhere (skill default is `true` — DO NOT use true).
- **No `Sentry.replayIntegration()`** — session replay records the DOM = patient
  data on screen. Drop it entirely. (Skill default adds replay — remove it.)
- Server `includeLocalVariables: false` (skill default `true` leaks patient
  objects into stack frames).
- `beforeSend: scrubEvent` on EVERY init (client/server/edge) — the scrubber
  from `lib/scrub.ts` (plan Task 6 Step 3). Keep `tracesSampleRate: 0.1`.
- DSN: `NEXT_PUBLIC_SENTRY_DSN` already in `.env.local`, EU region
  (`ingest.de.sentry.io`). Use `NEXT_PUBLIC_SENTRY_DSN` for client; server/edge
  may read the same value (set `SENTRY_DSN` too if preferred).
- `onRouterTransitionStart = Sentry.captureRouterTransitionStart` export in
  instrumentation-client is fine to keep.
- `withSentryConfig`: set `silent: !process.env.CI`; `authToken:
  process.env.SENTRY_AUTH_TOKEN`; org/project slugs from the Sentry project.
  `tunnelRoute` optional — if used, exclude it from auth middleware matcher.

## Keep from plan Task 6
- `lib/scrub.ts` `scrubEvent` (deletes request body/cookies/headers, redacts
  denylisted keys in extra/contexts) + `tests/unit/scrub.test.ts` (TDD).
- Privacy intent: no client/patient/health field ever reaches Sentry.
