import * as Sentry from '@sentry/nextjs'
import { scrubEvent } from '@/lib/scrub'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // GDPR: never send user identity, IP, or request headers automatically
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  // GDPR: do not capture local variables in stack frames — they may contain
  // patient objects (e.g. diet plan records, clinical notes)
  includeLocalVariables: false,
  // GDPR: scrub all PII/health fields before any event is sent to Sentry
  beforeSend: scrubEvent,
})
