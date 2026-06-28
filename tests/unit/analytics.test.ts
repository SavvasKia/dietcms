import { describe, it, expect, vi, beforeEach } from 'vitest'
import { assertSafeProps, capture } from '@/lib/analytics'

// Mock posthog-js so posthog.capture is a spy we control
vi.mock('posthog-js', () => ({
  default: {
    capture: vi.fn(),
  },
}))

describe('assertSafeProps', () => {
  it('allows non-identifying props', () => {
    expect(() => assertSafeProps({ plan: 'pro', step: 2 })).not.toThrow()
  })
  it('rejects identifying/health props', () => {
    expect(() => assertSafeProps({ clientName: 'Maria' })).toThrow()
    expect(() => assertSafeProps({ weight: 70 })).toThrow()
  })
})

describe('capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws and does NOT call posthog.capture when a denylisted prop is passed', async () => {
    const posthog = (await import('posthog-js')).default
    expect(() => capture('evt', { weight: 70 })).toThrow(/denylisted prop/)
    expect(posthog.capture).not.toHaveBeenCalled()
  })

  it('calls posthog.capture exactly once with safe props', async () => {
    const posthog = (await import('posthog-js')).default
    capture('evt', { plan: 'pro' })
    expect(posthog.capture).toHaveBeenCalledOnce()
    expect(posthog.capture).toHaveBeenCalledWith('evt', { plan: 'pro' })
  })
})
