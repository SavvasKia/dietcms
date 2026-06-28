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
