import { describe, it, expect } from 'vitest'
import type { ErrorEvent } from '@sentry/nextjs'
import { scrubEvent } from '@/lib/scrub'

// Helper: cast a partial fixture to ErrorEvent for testing scrubEvent.
// The function only reads the fields it acts on, so a partial object is safe.
const fixture = (obj: Partial<ErrorEvent>): ErrorEvent => obj as unknown as ErrorEvent

describe('scrubEvent', () => {
  it('removes request body, cookies, and headers', () => {
    const out = scrubEvent(
      fixture({ request: { data: { afm: '123' }, cookies: { s: 'x' }, headers: { a: 'b' } } }),
    )
    expect(out.request?.data).toBeUndefined()
    expect(out.request?.cookies).toBeUndefined()
    expect(out.request?.headers).toBeUndefined()
  })

  it('redacts denylisted keys anywhere in extra (including note)', () => {
    const out = scrubEvent(
      fixture({ extra: { clientName: 'Maria', weight: 70, note: 'ok', plan: 'pro', step: 2 } }),
    )
    expect(out.extra?.clientName).toBe('[redacted]')
    expect(out.extra?.weight).toBe('[redacted]')
    expect(out.extra?.note).toBe('[redacted]')
    // Safe keys must survive unredacted
    expect(out.extra?.plan).toBe('pro')
    expect(out.extra?.step).toBe(2)
  })

  it('redacts nested denylisted keys inside contexts', () => {
    const out = scrubEvent(
      fixture({ contexts: { runtime: { name: 'node', patientId: 'P001' } } }),
    )
    expect(out.contexts?.['runtime']?.['patientId']).toBe('[redacted]')
    expect(out.contexts?.['runtime']?.['name']).toBe('[redacted]') // 'name' is in denylist
  })

  it('strips user to id only (drops email, ip_address)', () => {
    const out = scrubEvent(
      fixture({ user: { id: 'u1', email: 'a@b.com', ip_address: '1.2.3.4', username: 'maria' } }),
    )
    expect(out.user).toEqual({ id: 'u1' })
  })

  it('strips user entirely when no id present', () => {
    const out = scrubEvent(fixture({ user: { email: 'a@b.com' } }))
    expect(out.user).toEqual({})
  })

  it('removes request query_string', () => {
    const out = scrubEvent(fixture({ request: { query_string: 'afm=123&name=Maria' } }))
    expect(out.request?.query_string).toBeUndefined()
  })

  it('clears breadcrumbs', () => {
    const out = scrubEvent(
      fixture({ breadcrumbs: [{ message: 'clicked login', data: { email: 'a@b.com' } }] }),
    )
    expect(out.breadcrumbs).toEqual([])
  })
})
