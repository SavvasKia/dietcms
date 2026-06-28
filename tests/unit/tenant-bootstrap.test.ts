import { describe, it, expect, vi } from 'vitest'

vi.mock('@/db/client', () => ({
  db: {
    // minimal fake: membership lookup + inserts
    _members: [],
  },
}))

// We test the pure decision function instead of the DB plumbing:
import { decideBootstrap } from '@/lib/tenant'

describe('decideBootstrap', () => {
  it('creates when no membership exists', () => {
    expect(decideBootstrap(null)).toEqual({ action: 'create' })
  })
  it('reuses existing tenant', () => {
    expect(decideBootstrap('t-1')).toEqual({ action: 'reuse', tenantId: 't-1' })
  })
})
