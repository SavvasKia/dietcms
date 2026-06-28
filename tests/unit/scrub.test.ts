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
