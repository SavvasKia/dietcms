import type { ErrorEvent } from '@sentry/nextjs'
import { PII_DENY } from './pii-denylist'

function redact<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj
  for (const k of Object.keys(obj as Record<string, unknown>)) {
    if (PII_DENY.test(k)) {
      ;(obj as Record<string, unknown>)[k] = '[redacted]'
    } else {
      redact((obj as Record<string, unknown>)[k])
    }
  }
  return obj
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.data
    delete event.request.cookies
    delete event.request.headers
    if (event.request.query_string) delete event.request.query_string
  }
  if (event.extra) redact(event.extra)
  if (event.contexts) redact(event.contexts)
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {}
  if (event.breadcrumbs) event.breadcrumbs = []
  return event
}
