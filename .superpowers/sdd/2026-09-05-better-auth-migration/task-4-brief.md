### Task 4: `getCurrentUser`

**Files:**
- Modify: `lib/auth.ts`
- Test: `tests/unit/auth-helpers.test.ts` (rewrite)

**Interfaces:**
- Consumes: `auth.api.getSession` from `lib/auth/server.ts` (Task 2); `headers` from `next/headers`.
- Produces: `getCurrentUser(): Promise<{id: string; email: string} | null>` — **unchanged signature**, consumed by `app/(app)/dashboard/page.tsx` and `lib/tenant.ts`'s callers (no edits needed there).

- [ ] **Step 1: Rewrite the test first**

Replace `tests/unit/auth-helpers.test.ts` entirely:

```ts
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
```

Note: better-auth's `getSession` return type requires `user.email: string` (non-nullable) — the old wrapper's "session with no user" and "null email" cases from the previous test can't occur with this library and are dropped rather than faked with unrealistic casts.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- auth-helpers`
Expected: FAIL — `lib/auth.ts` still calls `auth.getSession()` (doesn't exist on the mock).

- [ ] **Step 3: Rewrite `lib/auth.ts`**

```ts
import { auth } from '@/lib/auth/server'
import { headers } from 'next/headers'

export async function getCurrentUser(): Promise<{ id: string; email: string } | null> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  return { id: session.user.id, email: session.user.email }
}
```

Note: `session.user.email` is no longer nullable (better-auth requires it), so the old `?? ''` fallback is removed — it can no longer be exercised.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- auth-helpers`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add lib/auth.ts tests/unit/auth-helpers.test.ts
git commit -m "feat: rewrite getCurrentUser on better-auth's auth.api.getSession

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WUuVy2RNrDfxWAVui9w2uc"
```

---

