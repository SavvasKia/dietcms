import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/server', () => ({
  auth: { api: { getSession: vi.fn() } },
}))
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}))

import { auth } from '@/lib/auth/server'
import { getCurrentUser } from '@/lib/auth'

type SessionResult = Awaited<ReturnType<typeof auth.api.getSession>>

describe('getCurrentUser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null when getSession resolves null', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null)
    expect(await getCurrentUser()).toBeNull()
  })

  it('maps session.user.id and session.user.email to { id, email }', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue({
      session: {
        id: 's1',
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: 'u1',
        expiresAt: new Date(),
        token: 't1',
      },
      user: {
        id: 'u1',
        createdAt: new Date(),
        updatedAt: new Date(),
        email: 'a@b.gr',
        emailVerified: false,
        name: 'A',
      },
    } as unknown as SessionResult)
    expect(await getCurrentUser()).toEqual({ id: 'u1', email: 'a@b.gr' })
  })
})
