### Task 5: `proxy.ts`

**Files:**
- Modify: `proxy.ts`
- Test: `tests/unit/proxy.test.ts`

**Interfaces:**
- Consumes: `getSessionCookie` from `better-auth/cookies` — does **not** need `auth` from Task 2 at all (this is an optimistic cookie-existence check, not a validated session lookup; validation happens in `getCurrentUser`, Task 4).
- Produces: default export `proxy(request: NextRequest): NextResponse` + `config.matcher` — no other task consumes this (Next.js invokes it by route matching).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/proxy.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- proxy`
Expected: FAIL — `proxy.ts` still imports `auth` from `@/lib/auth/server` and calls `auth.middleware(...)`, which no longer exists on the better-auth instance.

- [ ] **Step 3: Rewrite `proxy.ts`**

```ts
import { getSessionCookie } from 'better-auth/cookies'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export default function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL('/auth/sign-in', request.url))
  }
  return NextResponse.next()
}

export const config = { matcher: ['/dashboard/:path*'] }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- proxy`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add proxy.ts tests/unit/proxy.test.ts
git commit -m "feat: swap proxy to better-auth's getSessionCookie optimistic check

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WUuVy2RNrDfxWAVui9w2uc"
```

---

