/**
 * The closed set of consent scopes — the single source shared by the database
 * CHECK (`db/schema.ts`) and the runtime guard (`lib/consents.ts`).
 *
 * It lives in `db/` rather than `lib/` because `db/schema.ts` must import it and
 * `lib/consents.ts` imports `db/authed-client`; defining it in `lib/` would make
 * that a cycle. This module is a LEAF on purpose — no imports at all — so
 * `db/schema.ts` stays loadable by plain `node` (scripts/check-gdpr-coverage.ts
 * imports it without a bundler or path aliases).
 *
 * RETIRING A SCOPE IS A MIGRATION, not an edit here. Dropping a member from the
 * union without one leaves live rows carrying a value `activeConsents` filters
 * out — the row stays in the table and stops being readable.
 */
export type ConsentScope = 'email_comms' | 'marketing' | 'third_party_sharing' | 'portal_access'

/** The closed set of scopes, and the order `activeConsents` returns them in. */
export const CONSENT_SCOPES = [
  'email_comms',
  'marketing',
  'third_party_sharing',
  'portal_access',
] as const satisfies readonly ConsentScope[]

// The other direction: adding a member to ConsentScope without listing it above
// makes this alias resolve to `false`, which fails the `extends true` bound.
type Assert<T extends true> = T
export type ConsentScopesAreComplete = Assert<
  Exclude<ConsentScope, (typeof CONSENT_SCOPES)[number]> extends never ? true : false
>
