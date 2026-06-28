import * as Sentry from '@sentry/nextjs'
import { scrubEvent } from '@/lib/scrub'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // GDPR: never send user identity, IP, or request headers automatically
  sendDefaultPii: false,
  // Low sample rate — this is a health-data app, minimise data egress
  tracesSampleRate: 0.1,
  // GDPR: scrub all PII/health fields before any event leaves the browser
  beforeSend: scrubEvent,
  // GDPR: NO replayIntegration — session replay records the DOM which may
  // contain patient data on screen
})
