### Task 3: Neon Auth (Stack Auth) integration

**Files:**
- Create: `stack.ts`, `app/handler/[...stack]/page.tsx`, `app/loading.tsx`
- Modify: `app/layout.tsx` (wrap with `StackProvider`/`StackTheme`)
- Create: `tests/unit/auth-helpers.test.ts`, `lib/auth.ts`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_STACK_PROJECT_ID`, `NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY`, `STACK_SECRET_SERVER_KEY`.
- Produces:
  - `stackServerApp` — server-side Stack app instance.
  - `getCurrentUser(): Promise<{ id: string; email: string } | null>` in `lib/auth.ts` — returns the authenticated user or null.

- [ ] **Step 1: Enable Neon Auth + verify current setup docs**

Manual: in the Neon console enable **Neon Auth** for the project; copy the three Stack keys into `.env.local`. Open the current Neon Auth + Next.js quickstart and confirm the package name and provider component names below are still current; adjust if changed (Execution note at top).

- [ ] **Step 2: Install Stack Auth**

Run: `pnpm add @stackframe/stack`

- [ ] **Step 3: Create the Stack server app**

`stack.ts`:
```ts
import 'server-only'
import { StackServerApp } from '@stackframe/stack'

export const stackServerApp = new StackServerApp({
  tokenStore: 'nextjs-cookie',
})
```

- [ ] **Step 4: Wire the auth handler route + provider**

`app/handler/[...stack]/page.tsx`:
```tsx
import { StackHandler } from '@stackframe/stack'
import { stackServerApp } from '@/stack'

export default function Handler(props: unknown) {
  return <StackHandler fullPage app={stackServerApp} routeProps={props} />
}
```

Modify `app/layout.tsx` to wrap children:
```tsx
import { StackProvider, StackTheme } from '@stackframe/stack'
import { stackServerApp } from '@/stack'
// inside <body>:
// <StackProvider app={stackServerApp}><StackTheme>{children}</StackTheme></StackProvider>
```

- [ ] **Step 5: Write the failing auth-helper test**

`tests/unit/auth-helpers.test.ts`:
```ts
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
```

Run: `pnpm exec vitest run tests/unit/auth-helpers.test.ts`
Expected: FAIL — `@/lib/auth` not found.

- [ ] **Step 6: Implement the auth helper**

`lib/auth.ts`:
```ts
import { stackServerApp } from '@/stack'

export async function getCurrentUser(): Promise<{ id: string; email: string } | null> {
  const user = await stackServerApp.getUser()
  if (!user) return null
  return { id: user.id, email: user.primaryEmail ?? '' }
}
```

- [ ] **Step 7: Run auth-helper test to verify pass**

Run: `pnpm exec vitest run tests/unit/auth-helpers.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: integrate Neon Auth (Stack Auth) with getCurrentUser helper"
```

---

