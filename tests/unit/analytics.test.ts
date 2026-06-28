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
