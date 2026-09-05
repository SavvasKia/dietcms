import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('better-auth/cookies', () => ({ getSessionCookie: vi.fn() }))

import { getSessionCookie } from 'better-auth/cookies'
import proxy from '../../proxy'

describe('proxy', () => {
  it('redirects to /auth/sign-in when there is no session cookie', () => {
    vi.mocked(getSessionCookie).mockReturnValue(null)
    const request = new NextRequest('http://localhost:3000/dashboard')
    const response = proxy(request)
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/auth/sign-in')
  })

  it('passes the request through when a session cookie is present', () => {
    vi.mocked(getSessionCookie).mockReturnValue('some-token')
    const request = new NextRequest('http://localhost:3000/dashboard')
    const response = proxy(request)
    expect(response.status).toBe(200)
  })
})
