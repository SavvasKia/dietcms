### Task 7: Sign-up server action

**Files:**
- Modify: `app/auth/sign-up/actions.ts`
- Test: `tests/unit/sign-up-action.test.ts`

**Interfaces:**
- Consumes: `auth.api.signUpEmail` from `lib/auth/server.ts` (Task 2); `APIError` from `better-auth/api`.
- Produces: `signUpWithEmail(prevState, formData): Promise<{error: string} | void>` — **unchanged signature**.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/sign-up-action.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- sign-up-action`
Expected: FAIL — `actions.ts` still calls `auth.signUp.email(...)`.

- [ ] **Step 3: Rewrite `app/auth/sign-up/actions.ts`**

```ts
'use server'

import { auth } from '@/lib/auth/server'
import { APIError } from 'better-auth/api'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

export async function signUpWithEmail(
  _prevState: { error: string } | null,
  formData: FormData,
) {
  const email = formData.get('email') as string

  if (!email) {
    return { error: 'Το email είναι υποχρεωτικό.' }
  }

  try {
    await auth.api.signUpEmail({
      body: {
        email,
        name: formData.get('name') as string,
        password: formData.get('password') as string,
      },
      headers: await headers(),
    })
  } catch (error) {
    if (error instanceof APIError) {
      return { error: error.message || 'Αποτυχία εγγραφής. Δοκιμάστε ξανά.' }
    }
    throw error
  }

  redirect('/dashboard')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- sign-up-action`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add app/auth/sign-up/actions.ts tests/unit/sign-up-action.test.ts
git commit -m "feat: rewrite sign-up action on auth.api.signUpEmail

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WUuVy2RNrDfxWAVui9w2uc"
```

---

