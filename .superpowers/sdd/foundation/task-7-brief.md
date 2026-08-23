### Task 7: PostHog (EU Cloud, input-masked) + analytics guard

**Files:**
- Create: `app/providers.tsx`, `lib/analytics.ts`, `tests/unit/analytics.test.ts`
- Modify: `app/layout.tsx` (mount providers)

**Interfaces:**
- Consumes: `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`.
- Produces: `capture(event: string, props?: Record<string, string | number | boolean>)` — wrapper that throws in tests if a denylisted key is passed, preventing health data in events.

- [ ] **Step 1: Install PostHog**

Run: `pnpm add posthog-js`

- [ ] **Step 2: Write the failing analytics-guard test**

`tests/unit/analytics.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { assertSafeProps } from '@/lib/analytics'

describe('assertSafeProps', () => {
  it('allows non-identifying props', () => {
    expect(() => assertSafeProps({ plan: 'pro', step: 2 })).not.toThrow()
  })
  it('rejects identifying/health props', () => {
    expect(() => assertSafeProps({ clientName: 'Maria' })).toThrow()
    expect(() => assertSafeProps({ weight: 70 })).toThrow()
  })
})
```

Run: `pnpm exec vitest run tests/unit/analytics.test.ts`
Expected: FAIL — `@/lib/analytics` not found.

- [ ] **Step 3: Implement the analytics guard + capture**

`lib/analytics.ts`:
```ts
import posthog from 'posthog-js'
import { isDenied } from '@/lib/pii-denylist' // shared GDPR denylist (created in Task 6)

export function assertSafeProps(props: Record<string, unknown>): void {
  for (const k of Object.keys(props)) {
    if (isDenied(k)) throw new Error(`analytics: denylisted prop "${k}" — never send personal/health data`)
  }
}

export function capture(event: string, props: Record<string, string | number | boolean> = {}): void {
  assertSafeProps(props)
  posthog.capture(event, props)
}
```

- [ ] **Step 4: Run analytics test to verify pass**

Run: `pnpm exec vitest run tests/unit/analytics.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount PostHog provider (EU host, full input masking)**

`app/providers.tsx`:
```tsx
'use client'
import posthog from 'posthog-js'
import { PostHogProvider } from 'posthog-js/react'
import { useEffect } from 'react'

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST, // https://eu.i.posthog.com
      autocapture: { dom_event_allowlist: ['click'] },
      mask_all_text: true,
      mask_all_element_attributes: true,
      session_recording: { maskAllInputs: true, maskTextSelector: '*' },
      person_profiles: 'identified_only',
    })
  }, [])
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>
}
```
Mount `<Providers>` in `app/layout.tsx` inside the Stack provider.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add PostHog (EU, input-masked) with analytics safety guard"
```

---

