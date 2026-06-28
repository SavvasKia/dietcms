// Shared PII / special-category (health) key denylist. Used by Sentry scrubbing
// (lib/scrub.ts) and analytics guarding (lib/analytics.ts). GDPR-critical: keep
// ONE copy so the two consumers cannot drift.
export const PII_DENY =
  /(name|email|phone|afm|dob|birth|address|weight|height|bmi|body|medical|allergy|diagnos|note|client|patient)/i

export function isDenied(key: string): boolean {
  return PII_DENY.test(key)
}
