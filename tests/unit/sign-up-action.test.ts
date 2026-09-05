import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/server', () => ({
  auth: { api: { signUpEmail: vi.fn() } },
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
import { signUpWithEmail } from '@/app/auth/sign-up/actions'

type SignUpResult = Awaited<ReturnType<typeof auth.api.signUpEmail>>

function formData(fields: Record<string, string>) {
  const fd = new FormData()
  for (const [key, value] of Object.entries(fields)) fd.set(key, value)
  return fd
}

describe('signUpWithEmail', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns an error when email is missing', async () => {
    const result = await signUpWithEmail(null, formData({ name: 'A', password: 'secret123' }))
    expect(result).toEqual({ error: 'Το email είναι υποχρεωτικό.' })
    expect(auth.api.signUpEmail).not.toHaveBeenCalled()
  })

  it('redirects to /dashboard on success', async () => {
    vi.mocked(auth.api.signUpEmail).mockResolvedValue({
      token: 't1',
      user: {
        id: 'u1',
        email: 'a@b.gr',
        name: 'A',
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as unknown as SignUpResult)

    await signUpWithEmail(
      null,
      formData({ name: 'A', email: 'a@b.gr', password: 'secret123' }),
    )

    expect(redirect).toHaveBeenCalledWith('/dashboard')
  })

  it('returns the APIError message and does not redirect on duplicate email', async () => {
    vi.mocked(auth.api.signUpEmail).mockRejectedValue(
      new APIError('UNPROCESSABLE_ENTITY', { message: 'User already exists' }),
    )

    const result = await signUpWithEmail(
      null,
      formData({ name: 'A', email: 'a@b.gr', password: 'secret123' }),
    )

    expect(result).toEqual({ error: 'User already exists' })
    expect(redirect).not.toHaveBeenCalled()
  })
})
