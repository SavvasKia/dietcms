/**
 * The closed set of appointment statuses — the single source shared by the
 * database CHECK (`db/schema.ts`) and the runtime guard
 * (`lib/appointments.ts`).
 *
 * Same placement rule as `db/consent-scopes.ts`: it lives in `db/` because
 * `db/schema.ts` must import it while `lib/appointments.ts` imports
 * `db/authed-client`, so defining it in `lib/` would be a cycle. A LEAF on
 * purpose — no imports at all — so `db/schema.ts` stays loadable by
 * `scripts/check-gdpr-coverage.ts` without a bundler or path aliases.
 *
 * RETIRING A STATUS IS A MIGRATION, not an edit here. Dropping a member from
 * the union without one leaves live rows carrying a value the type says is
 * impossible.
 */
export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show'

/**
 * The closed set. `scheduled` leads because it is the column default: an
 * appointment exists because it was booked.
 *
 * `cancelled` and `no_show` are deliberately distinct. They are the same thing
 * to a calendar and completely different things to a practice — one is the
 * client telling you, the other is finding out at the appointment time — and
 * collapsing them would make the difference unrecoverable after the fact.
 */
export const APPOINTMENT_STATUSES = [
  'scheduled',
  'completed',
  'cancelled',
  'no_show',
] as const satisfies readonly AppointmentStatus[]

/**
 * Statuses that still occupy their slot. A cancelled or missed appointment
 * frees the time, so the overlap constraint in migration 0010 is PARTIAL on
 * exactly this set — keep the two in step, and see the note there.
 */
export const BLOCKING_STATUSES = ['scheduled', 'completed'] as const satisfies readonly AppointmentStatus[]

// The other direction: adding a member to AppointmentStatus without listing it
// above makes this alias resolve to `false`, which fails the `extends true`
// bound — a typecheck error, not a silently missing status.
type Assert<T extends true> = T
export type AppointmentStatusesAreComplete = Assert<
  Exclude<AppointmentStatus, (typeof APPOINTMENT_STATUSES)[number]> extends never ? true : false
>
