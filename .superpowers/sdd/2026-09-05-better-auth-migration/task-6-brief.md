### Task 6: Sign-in server action

**Files:**
- Modify: `app/auth/sign-in/actions.ts`
- Test: `tests/unit/sign-in-action.test.ts`

**Interfaces:**
- Consumes: `auth.api.signInEmail` from `lib/auth/server.ts` (Task 2); `APIError` from `better-auth/api`.
- Produces: `signInWithEmail(prevState, formData): Promise<{error: string} | void>` — **unchanged signature**, no other task consumes it (bound to the sign-in form).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/sign-in-action.test.ts`:

```ts
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
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- sign-in-action`
Expected: FAIL — `actions.ts` still calls `auth.signIn.email(...)`, which doesn't exist on the mock, and returns `{error}` instead of throwing, so the APIError-handling assertions fail too.

- [ ] **Step 3: Rewrite `app/auth/sign-in/actions.ts`**

```ts
'use server'

import { auth } from '@/lib/auth/server'
import { APIError } from 'better-auth/api'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

export async function signInWithEmail(
  _prevState: { error: string } | null,
  formData: FormData,
) {
  try {
    await auth.api.signInEmail({
      body: {
        email: formData.get('email') as string,
        password: formData.get('password') as string,
      },
      headers: await headers(),
    })
  } catch (error) {
    if (error instanceof APIError) {
      return { error: error.message || 'Αποτυχία σύνδεσης. Δοκιμάστε ξανά.' }
    }
    throw error
  }

  redirect('/dashboard')
}
```

`redirect()` stays outside the `catch` block deliberately — Next's redirect works by throwing an internal signal, and a catch-all around it would swallow that signal and turn a successful sign-in into a silent no-op.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- sign-in-action`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add app/auth/sign-in/actions.ts tests/unit/sign-in-action.test.ts
git commit -m "feat: rewrite sign-in action on auth.api.signInEmail

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WUuVy2RNrDfxWAVui9w2uc"
```

---

