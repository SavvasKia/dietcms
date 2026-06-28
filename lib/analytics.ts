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
