import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/server', () => ({
  auth: { api: { signInEmail: vi.fn() } },
}))
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}))

import { APIError } from 'better-auth/api'
import { auth } from '@/lib/auth/server'
import { redirect } from 'next/navigation'
import { signInWithEmail } from '@/app/auth/sign-in/actions'

type SignInResult = Awaited<ReturnType<typeof auth.api.signInEmail>>

function formData(fields: Record<string, string>) {
  const fd = new FormData()
  for (const [key, value] of Object.entries(fields)) fd.set(key, value)
  return fd
}

describe('signInWithEmail', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redirects to /dashboard on success', async () => {
    vi.mocked(auth.api.signInEmail).mockResolvedValue({
      redirect: false,
      token: 't1',
      user: {
        id: 'u1',
        email: 'a@b.gr',
        name: 'A',
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as unknown as SignInResult)

    await signInWithEmail(null, formData({ email: 'a@b.gr', password: 'secret123' }))

    expect(redirect).toHaveBeenCalledWith('/dashboard')
  })

  it('returns the APIError message and does not redirect on bad credentials', async () => {
    vi.mocked(auth.api.signInEmail).mockRejectedValue(
      new APIError('UNAUTHORIZED', { message: 'Invalid email or password' }),
    )

    const result = await signInWithEmail(null, formData({ email: 'a@b.gr', password: 'wrong' }))

    expect(result).toEqual({ error: 'Invalid email or password' })
    expect(redirect).not.toHaveBeenCalled()
  })

  it('falls back to the Greek default message when the APIError has no message', async () => {
    vi.mocked(auth.api.signInEmail).mockRejectedValue(new APIError('UNAUTHORIZED', {}))

    const result = await signInWithEmail(null, formData({ email: 'a@b.gr', password: 'wrong' }))

    expect(result).toEqual({ error: 'Αποτυχία σύνδεσης. Δοκιμάστε ξανά.' })
  })

  it('re-throws an error that is not an APIError', async () => {
    vi.mocked(auth.api.signInEmail).mockRejectedValue(new Error('unexpected'))

    await expect(
      signInWithEmail(null, formData({ email: 'a@b.gr', password: 'wrong' })),
    ).rejects.toThrow('unexpected')

    expect(redirect).not.toHaveBeenCalled()
  })
})
