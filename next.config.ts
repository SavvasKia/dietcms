import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

const nextConfig: NextConfig = {
  /* config options here */
}

export default withSentryConfig(nextConfig, {
  // Sentry org/project read from env so source-map upload just no-ops in dev
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Auth token for source-map upload (leave blank in dev — no-ops gracefully)
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Suppress build logs in local dev; emit them in CI for visibility
  silent: !process.env.CI,
  // Tree-shake session-replay code entirely — we never use replayIntegration
  bundleSizeOptimizations: {
    excludeReplayIframe: true,
    excludeReplayShadowDom: true,
  },
})
