import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/server', () => ({
  auth: { getSession: vi.fn() },
}))

import { auth } from '@/lib/auth/server'
import { getCurrentUser } from '@/lib/auth'

describe('getCurrentUser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null when getSession resolves with no session data', async () => {
    ;(auth.getSession as any).mockResolvedValue({ data: null })
    expect(await getCurrentUser()).toBeNull()
  })

  it('returns null when session has no user', async () => {
    ;(auth.getSession as any).mockResolvedValue({ data: {} })
    expect(await getCurrentUser()).toBeNull()
  })

  it('maps session.user.id and session.user.email to { id, email }', async () => {
    ;(auth.getSession as any).mockResolvedValue({
      data: { user: { id: 'u1', email: 'a@b.gr' } },
    })
    expect(await getCurrentUser()).toEqual({ id: 'u1', email: 'a@b.gr' })
  })

  it('falls back to empty string when email is null', async () => {
    ;(auth.getSession as any).mockResolvedValue({
      data: { user: { id: 'u2', email: null } },
    })
    expect(await getCurrentUser()).toEqual({ id: 'u2', email: '' })
  })
})
