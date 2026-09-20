import { desc, eq, sql } from 'drizzle-orm'
import { withUser } from '@/db/authed-client'
import { measurements } from '@/db/schema'
import { recordAudit } from '@/lib/audit'
import { reachableClient, recordDeny } from '@/lib/client-access'

export type NewMeasurement = {
  /** ISO-8601. Omitted means "now" — the column defaults to the DB clock. */
  measuredAt?: string
  weightKg?: number
  heightCm?: number
  bodyFatPct?: number
  waistCm?: number
  hipCm?: number
  notes?: string
}

// Runtime whitelist of caller-writable columns (same defect class as Task 2's
// mass assignment on clients, guarded the same way). Everything not listed is
// dropped before it reaches the DB, so a request body cannot reach id,
// createdAt, tenantId, or clientId — the last two are resolved from the
// reachability check, never from input.
const NEW_MEASUREMENT_KEYS = [
  'measuredAt',
  'weightKg',
  'heightCm',
  'bodyFatPct',
  'waistCm',
  'hipCm',
  'notes',
] as const satisfies readonly (keyof NewMeasurement)[]

// The other direction: adding a field to NewMeasurement without listing it
// above makes this alias resolve to `false`, which fails the `extends true`
// bound — a typecheck error, not a silently dropped column.
type Assert<T extends true> = T
export type NewMeasurementKeysAreComplete = Assert<
  Exclude<keyof NewMeasurement, (typeof NEW_MEASUREMENT_KEYS)[number]> extends never ? true : false
>

/** The metric columns. A row must carry at least one — `measurements_not_empty`
 *  enforces it at the DB, `recordMeasurement` rejects it before the round trip.
 *  `measuredAt` and `notes` are deliberately absent: neither is an observation. */
const METRICS = ['weightKg', 'heightCm', 'bodyFatPct', 'waistCm', 'hipCm'] as const

/**
 * The whitelisted fields that go into the insert AS THEY ARRIVE.
 *
 * `measuredAt` is excluded from the return TYPE as well as skipped at runtime:
 * it arrives as an ISO string and the column takes a Date or SQL, so leaving it
 * in the spread's type is what makes the insert reject the whole object. It is
 * applied separately below, as a SQL cast.
 */
function pickMeasurementFields(input: NewMeasurement): Partial<Omit<NewMeasurement, 'measuredAt'>> {
  const src = input as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of NEW_MEASUREMENT_KEYS) {
    if (key !== 'measuredAt' && src[key] !== undefined) out[key] = src[key]
  }
  return out as Partial<Omit<NewMeasurement, 'measuredAt'>>
}

export type Measurement = typeof measurements.$inferSelect

/**
 * Body mass index, kg/m^2, to one decimal — DERIVED, never stored. A `bmi`
 * column would be a second copy of weight and height that goes stale the
 * moment either is corrected.
 *
 * Null for any input that cannot produce a meaningful number, rather than
 * NaN or Infinity: this is also called on unsaved form input, where a
 * half-typed height of `0` would otherwise render as `Infinity` in the UI. The
 * DB CHECKs reject non-positive values too, but only once the row is saved.
 */
export function bmi(weightKg: number | null, heightCm: number | null): number | null {
  if (weightKg === null || heightCm === null) return null
  if (weightKg <= 0 || heightCm <= 0) return null
  const metres = heightCm / 100
  return Math.round((weightKg / (metres * metres)) * 10) / 10
}

/**
 * Record one dated observation for a client.
 *
 * Returns null when the client is not reachable (unknown, soft-deleted, or
 * another tenant's) — null rather than a throw because the deny audit row is
 * written in the same transaction, and a throw would roll it back.
 *
 * Rejects an all-null row BEFORE opening a transaction. `measurements_not_empty`
 * would catch it anyway, but as a 23514 naming a constraint instead of a
 * legible message, and only after a round trip. Same pairing shape as
 * assertScope and client_consents_scope_known: the runtime guard is the legible
 * one, the constraint is the one nothing can bypass.
 *
 * Throws (rather than returning null) because an empty submission is a caller
 * BUG, not a permission outcome — and this function is `async`, so it surfaces
 * as a rejected promise rather than a synchronous throw that slips past a
 * caller's `.catch()`.
 */
export async function recordMeasurement(
  userId: string,
  clientId: string,
  input: NewMeasurement,
): Promise<Measurement | null> {
  if (METRICS.every((k) => input[k] === undefined || input[k] === null)) {
    throw new Error('a measurement must carry at least one metric')
  }

  return withUser(userId, async (tx) => {
    const client = await reachableClient(tx, clientId)
    if (!client) {
      await recordDeny(tx, 'measurement')
      return null
    }

    const [row] = await tx
      .insert(measurements)
      .values({
        ...pickMeasurementFields(input),
        // From the reachability check, never from input: tenantId is what RLS
        // matches on, and clientId is the row the caller was proven to reach.
        tenantId: client.tenantId,
        clientId: client.id,
        // Cast in SQL rather than `new Date(...)`: the DB-clock rule bans
        // `new Date` in lib/, and Postgres validates the literal for us — a
        // malformed instant is a 22007 at insert time instead of a silent
        // `Invalid Date` persisted as NULL. Omitted entirely when the caller
        // gave none, so the column's own defaultNow() applies.
        ...(input.measuredAt === undefined
          ? {}
          : { measuredAt: sql`${input.measuredAt}::timestamptz` }),
      })
      .returning()

    // Same tx as the insert: a failed audit write rolls the measurement back,
    // so nothing clinical is recorded unaudited. A COUNT only — the PII
    // denylist forbids weight/height/body keys in metadata, and the values are
    // special-category health data that must not be copied into the one table
    // that survives erasure.
    await recordAudit(tx, {
      action: 'create',
      entity: 'measurement',
      entityId: row.id,
      clientId: client.id,
      metadata: { metrics: METRICS.filter((k) => row[k] !== null).length },
      tenantId: client.tenantId,
    })
    return row
  })
}

/**
 * One client's measurement history, newest first — the order both the chart and
 * the history table read, and the order
 * `measurements_client_id_measured_at_idx` serves.
 *
 * Ties on measured_at are broken by created_at: two weigh-ins entered for the
 * same date would otherwise come back in an order Postgres is free to vary
 * between calls, which reads as data corruption in a trend view.
 */
export function listMeasurements(userId: string, clientId: string): Promise<Measurement[]> {
  return withUser(userId, async (tx) => {
    const client = await reachableClient(tx, clientId)
    if (!client) {
      await recordDeny(tx, 'measurement')
      return []
    }

    const rows = await tx
      .select()
      .from(measurements)
      .where(eq(measurements.clientId, client.id))
      .orderBy(desc(measurements.measuredAt), desc(measurements.createdAt))

    // Reading a client's measurements is access to special-category client data
    // (spec §5). ONE row for the list, not one per measurement.
    await recordAudit(tx, {
      action: 'view',
      entity: 'measurement',
      entityId: null,
      clientId: client.id,
      metadata: { count: rows.length },
      tenantId: client.tenantId,
    })
    return rows
  })
}

/**
 * Delete one measurement. A HARD delete, unlike clients.
 *
 * An observation is a fact entered by hand, and the only reason to remove one
 * is that it was entered wrongly — correcting a typo is delete-then-record. A
 * soft-deleted typo is a row every future reader has to remember to filter out.
 * Consents are the opposite case (the history IS the evidence) and are never
 * deleted; the distinction is deliberate, not an inconsistency.
 *
 * The audit row survives, so "a measurement was deleted, by whom, when" stays
 * answerable after the value itself is gone.
 *
 * Takes the measurement id, not a client id: the delete's own RLS predicate is
 * the ownership check, and the client it belonged to is read back from the
 * deleted row rather than trusted from the caller.
 */
export function deleteMeasurement(userId: string, measurementId: string): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const deleted = await tx
      .delete(measurements)
      .where(eq(measurements.id, measurementId))
      .returning({ id: measurements.id, clientId: measurements.clientId })

    if (deleted.length === 0) {
      // A miss is indistinguishable from a cross-tenant probe: RLS filters both
      // to the same empty result. Log it either way.
      await recordDeny(tx, 'measurement')
      return false
    }

    // No tenantId passed: recordAudit resolves it from the caller's membership,
    // which must exist — a row was just deleted under a policy that matches on
    // it. Nothing was read here that already knew it.
    await recordAudit(tx, {
      action: 'delete',
      entity: 'measurement',
      entityId: deleted[0].id,
      clientId: deleted[0].clientId,
    })
    return true
  })
}
