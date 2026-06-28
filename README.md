This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Environment Variables

The following environment variables are required. All services must use EU-region endpoints.

| Variable | Description |
|---|---|
| `DATABASE_URL` | Neon connection string (unauthenticated / pooled) |
| `DATABASE_URL_AUTHENTICATED` | Neon connection string for RLS-authenticated sessions |
| `NEON_AUTH_BASE_URL` | Neon Auth API base URL (EU endpoint) |
| `NEON_AUTH_COOKIE_SECRET` | Secret used to sign Neon Auth session cookies |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSN — use an EU-region project |
| `NEXT_PUBLIC_POSTHOG_KEY` | PostHog project API key |
| `NEXT_PUBLIC_POSTHOG_HOST` | PostHog ingest host — must be `https://eu.i.posthog.com` |

Copy `.env.local.example` (if present) to `.env.local` and fill in values before running locally.

## EU-Region Requirement

All infrastructure is pinned to the EU:

- **Neon**: database and Neon Auth must be provisioned in the EU region.
- **Vercel**: `vercel.json` pins serverless functions to `fra1` (Frankfurt). The Vercel project region must also be set to `fra1` in the dashboard.
- **Sentry**: use an EU-region Sentry project (DSN hostname ends in `.de.sentry.io`).
- **PostHog**: set `NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com`.

## CI / Testing

Run these commands locally (and in CI):

```bash
pnpm typecheck    # TypeScript type-checking (tsc --noEmit)
pnpm lint         # ESLint
pnpm test         # Vitest unit tests
```

For end-to-end tests, install the Playwright browser first (requires root/sudo in CI):

```bash
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

### Integration / RLS Tests

RLS isolation tests require a live Neon connection and valid JWTs. These tests are **not** part of the default CI job — they run in a separate, secrets-gated job (or manually) with `DATABASE_URL_AUTHENTICATED` and test JWTs set as CI secrets. Do not run them in the default `pnpm test` suite.

## Deploy on Vercel (Manual Steps)

Connecting the project to Vercel and configuring live environment variables is a **manual step**:

1. Import the repository in the [Vercel dashboard](https://vercel.com/new).
2. In Project Settings > General, confirm the **Function Region** is set to `fra1`.
3. In Project Settings > Environment Variables, add all variables listed in the [Environment Variables](#environment-variables) section above — using EU-region values for every service.
4. Trigger a deployment (push to `main` or click "Redeploy").
5. After deploy, run the Playwright smoke suite against the preview URL and manually verify sign-up + tenant creation against Neon.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out the [Next.js GitHub repository](https://github.com/vercel/next.js) — your feedback and contributions are welcome!
