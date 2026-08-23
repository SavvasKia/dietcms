### Task 6: Sentry with PII scrubbing + privacy regression test

**Files:**
- Create: `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation.ts`
- Create: `lib/scrub.ts`, `tests/unit/scrub.test.ts`
- Modify: `next.config.ts` (wrap with `withSentryConfig`)

**Interfaces:**
- Consumes: `NEXT_PUBLIC_SENTRY_DSN`.
- Produces: `scrubEvent(event)` — strips request bodies, cookies, and any key matching the PII/health denylist; used as Sentry `beforeSend`.

- [ ] **Step 1: Install Sentry**

Run: `pnpm add @sentry/nextjs`

- [ ] **Step 2: Write the failing scrub test**

`tests/unit/scrub.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { scrubEvent } from '@/lib/scrub'

describe('scrubEvent', () => {
  it('removes request body and cookies', () => {
    const out = scrubEvent({ request: { data: { afm: '123' }, cookies: { s: 'x' }, headers: { a: 'b' } } } as any)
    expect(out.request?.data).toBeUndefined()
    expect(out.request?.cookies).toBeUndefined()
  })
  it('redacts denylisted keys anywhere in extra', () => {
    const out = scrubEvent({ extra: { clientName: 'Maria', weight: 70, note: 'ok' } } as any)
    expect(out.extra?.clientName).toBe('[redacted]')
    expect(out.extra?.weight).toBe('[redacted]')
    expect(out.extra?.note).toBe('ok')
  })
})
```

Run: `pnpm exec vitest run tests/unit/scrub.test.ts`
Expected: FAIL — `@/lib/scrub` not found.

- [ ] **Step 3: Implement the scrubber**

`lib/scrub.ts`:
```ts
import type { ErrorEvent } from '@sentry/nextjs'

const DENY = /(name|email|phone|afm|dob|birth|address|weight|height|bmi|body|medical|allergy|diagnos|note|client|patient)/i

function redact<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj
  for (const k of Object.keys(obj as Record<string, unknown>)) {
    if (DENY.test(k)) (obj as Record<string, unknown>)[k] = '[redacted]'
    else redact((obj as Record<string, unknown>)[k])
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
```

- [ ] **Step 4: Run scrub test to verify pass**

Run: `pnpm exec vitest run tests/unit/scrub.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire Sentry configs (EU region, scrubber, no PII)**

`sentry.client.config.ts` / `sentry.server.config.ts` / `sentry.edge.config.ts` each:
```ts
import * as Sentry from '@sentry/nextjs'
import { scrubEvent } from '@/lib/scrub'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  beforeSend: scrubEvent,
})
```
`instrumentation.ts`:
```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./sentry.server.config')
  if (process.env.NEXT_RUNTIME === 'edge') await import('./sentry.edge.config')
}
```
Wrap `next.config.ts` export with `withSentryConfig(nextConfig, { silent: true })`. Confirm the Sentry **project data region is EU** in the Sentry dashboard (Global Constraint).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Sentry with PII/health scrubbing and regression test"
```

---

