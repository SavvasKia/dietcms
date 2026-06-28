import type { ErrorEvent } from '@sentry/nextjs'

// 'note' intentionally omitted: bare key 'note' is non-PII per regression test;
// compound keys like 'medicalNote' are caught by 'medical'.
const DENY =
  /(name|email|phone|afm|dob|birth|address|weight|height|bmi|body|medical|allergy|diagnos|client|patient)/i

function redact<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj
  for (const k of Object.keys(obj as Record<string, unknown>)) {
    if (DENY.test(k)) {
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
  }
  if (event.extra) redact(event.extra)
  if (event.contexts) redact(event.contexts)
  return event
}
