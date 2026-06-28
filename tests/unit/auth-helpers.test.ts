import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/stack', () => ({
  stackServerApp: { getUser: vi.fn() },
}))

import { stackServerApp } from '@/stack'
import { getCurrentUser } from '@/lib/auth'

describe('getCurrentUser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null when no user', async () => {
    ;(stackServerApp.getUser as any).mockResolvedValue(null)
    expect(await getCurrentUser()).toBeNull()
  })

  it('maps id and primaryEmail', async () => {
    ;(stackServerApp.getUser as any).mockResolvedValue({ id: 'u1', primaryEmail: 'a@b.gr' })
    expect(await getCurrentUser()).toEqual({ id: 'u1', email: 'a@b.gr' })
  })
})
