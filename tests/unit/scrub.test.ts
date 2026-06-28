import { describe, it, expect } from 'vitest'
import { scrubEvent } from '@/lib/scrub'

describe('scrubEvent', () => {
  it('removes request body, cookies, and headers', () => {
    const out = scrubEvent({
      request: { data: { afm: '123' }, cookies: { s: 'x' }, headers: { a: 'b' } },
    } as any)
    expect(out.request?.data).toBeUndefined()
    expect(out.request?.cookies).toBeUndefined()
    expect(out.request?.headers).toBeUndefined()
  })

  it('redacts denylisted keys anywhere in extra (including note)', () => {
    const out = scrubEvent({
      extra: { clientName: 'Maria', weight: 70, note: 'ok', plan: 'pro', step: 2 },
    } as any)
    expect(out.extra?.clientName).toBe('[redacted]')
    expect(out.extra?.weight).toBe('[redacted]')
    expect(out.extra?.note).toBe('[redacted]')
    // Safe keys must survive unredacted
    expect(out.extra?.plan).toBe('pro')
    expect(out.extra?.step).toBe(2)
  })

  it('redacts nested denylisted keys inside contexts', () => {
    const out = scrubEvent({
      contexts: { runtime: { name: 'node', patientId: 'P001' } },
    } as any)
    expect((out.contexts as any)?.runtime?.patientId).toBe('[redacted]')
    expect((out.contexts as any)?.runtime?.name).toBe('[redacted]') // 'name' is in denylist
  })

  it('strips user to id only (drops email, ip_address)', () => {
    const out = scrubEvent({
      user: { id: 'u1', email: 'a@b.com', ip_address: '1.2.3.4', username: 'maria' },
    } as any)
    expect(out.user).toEqual({ id: 'u1' })
  })

  it('strips user entirely when no id present', () => {
    const out = scrubEvent({ user: { email: 'a@b.com' } } as any)
    expect(out.user).toEqual({})
  })

  it('removes request query_string', () => {
    const out = scrubEvent({ request: { query_string: 'afm=123&name=Maria' } } as any)
    expect(out.request?.query_string).toBeUndefined()
  })

  it('clears breadcrumbs', () => {
    const out = scrubEvent({
      breadcrumbs: [{ message: 'clicked login', data: { email: 'a@b.com' } }],
    } as any)
    expect(out.breadcrumbs).toEqual([])
  })
})
