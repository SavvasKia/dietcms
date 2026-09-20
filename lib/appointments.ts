import { and, asc, eq, gte, lt, sql } from 'drizzle-orm'
import { withUser } from '@/db/authed-client'
import { appointments } from '@/db/schema'
import { APPOINTMENT_STATUSES, type AppointmentStatus } from '@/db/appointment-statuses'
import { recordAudit } from '@/lib/audit'
import { callerTenantIdOrNull, reachableClient, recordDeny } from '@/lib/client-access'

export type NewAppointment = {
  /** ISO-8601. Both required — an appointment with no end cannot be checked for
   *  overlap, and `appointments_ends_after_starts` would reject a null anyway. */
  startsAt: string
  endsAt: string
  location?: string
  notes?: string
}

export type Appointment = typeof appointments.$inferSelect

/** Thrown when the slot is already taken. Distinguishable from a permission
 *  outcome (null) and from a caller bug: the route layer maps this to a 409, not
 *  a 400 or a 403. */
export class AppointmentOverlapError extends Error {
  constructor() {
    super('that time overlaps an existing appointment')
    this.name = 'AppointmentOverlapError'
  }
}

/**
 * `appointments_no_overlap` (migration 0010) rejecting the write.
 *
 * NOT a read-then-write check in this module, deliberately: two concurrent
 * bookings would both see a free slot and both insert — the same TOCTOU race
 * the consent grant had, which needed a FOR UPDATE to close. An exclusion
 * constraint has no window at all, so the only thing left to do here is
 * translate its error code into something a caller can act on.
 */
function isOverlap(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23P01'
}

/**
 * `status` arrives from callers as a plain string — a value out of `JSON.parse`
 * in a route handler has bypassed the TypeScript union entirely.
 *
 * `appointments_status_known` backstops this in the database, so a gap here is
 * a 23514 rather than an unreadable row. Keep both: this one fails with a
 * legible message and without opening a transaction.
 */
function assertStatus(status: AppointmentStatus): void {
  if (!(APPOINTMENT_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`unknown appointment status "${status}"`)
  }
}

/** Both instants, or a legible error. `appointments_ends_after_starts` enforces
 *  the same thing in the database; this is the half that names the problem. */
function assertInterval(startsAt: string, endsAt: string): void {
  const start = Date.parse(startsAt)
  const end = Date.parse(endsAt)
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error('appointment times must be ISO-8601 instants')
  }
  if (end <= start) throw new Error('an appointment must end after it starts')
}

// All mutation timestamps come from the DB clock, the same source as the
// columns' defaultNow(). The app clock would let a skewed function host persist
// updated_at < created_at.
const dbNow = sql`now()`

/** Caller-supplied instants go through Postgres rather than `new Date(...)`:
 *  the DB-clock rule bans that constructor in lib/, and this way a malformed
 *  literal is a 22007 at write time instead of an Invalid Date persisted as
 *  null. `assertInterval` has already rejected the obvious cases. */
const instant = (iso: string) => sql`${iso}::timestamptz`

/**
 * Book an appointment for a client.
 *
 * Returns null when the client is not reachable (unknown, soft-deleted, or
 * another tenant's) — null rather than a throw because the deny audit row is
 * written in the same transaction, and a throw would roll it back.
 *
 * Throws `AppointmentOverlapError` when the slot is taken. That is not a
 * permission outcome and not a caller bug: it is a legitimate conflict the user
 * has to resolve, so it gets its own type rather than a null the caller cannot
 * tell apart from "no such client".
 */
export async function scheduleAppointment(
  userId: string,
  clientId: string,
  input: NewAppointment,
): Promise<Appointment | null> {
  assertInterval(input.startsAt, input.endsAt)

  return withUser(userId, async (tx) => {
    const client = await reachableClient(tx, clientId)
    if (!client) {
      await recordDeny(tx, 'appointment')
      return null
    }

    let row: Appointment
    try {
      ;[row] = await tx
        .insert(appointments)
        .values({
          // From the reachability check, never from input.
          tenantId: client.tenantId,
          clientId: client.id,
          startsAt: instant(input.startsAt),
          endsAt: instant(input.endsAt),
          location: input.location,
          notes: input.notes,
        })
        .returning()
    } catch (err) {
      if (isOverlap(err)) throw new AppointmentOverlapError()
      throw err
    }

    // Same tx as the insert: a failed audit write rolls the booking back, so
    // nothing is scheduled unaudited. No times in metadata — the denylist would
    // not catch a `startsAt` key, and when a client appeared at the practice is
    // data about them that the audit trail outlives erasure to keep.
    await recordAudit(tx, {
      action: 'create',
      entity: 'appointment',
      entityId: row.id,
      clientId: client.id,
      tenantId: client.tenantId,
    })
    return row
  })
}

/**
 * One client's appointments, earliest first — the order a client record page
 * reads, served by `appointments_client_id_starts_at_idx`.
 *
 * Every status, including cancelled: the history of a cancelled appointment is
 * exactly what the practice needs to see on the record.
 */
export function listAppointments(userId: string, clientId: string): Promise<Appointment[]> {
  return withUser(userId, async (tx) => {
    const client = await reachableClient(tx, clientId)
    if (!client) {
      await recordDeny(tx, 'appointment')
      return []
    }

    const rows = await tx
      .select()
      .from(appointments)
      .where(eq(appointments.clientId, client.id))
      .orderBy(asc(appointments.startsAt))

    await recordAudit(tx, {
      action: 'view',
      entity: 'appointment',
      entityId: null,
      clientId: client.id,
      metadata: { count: rows.length },
      tenantId: client.tenantId,
    })
    return rows
  })
}

/**
 * The practice calendar: every appointment in the caller's tenant starting in
 * `[from, to)`, whichever client it belongs to. Served by
 * `appointments_tenant_id_starts_at_idx`.
 *
 * Half-open to match the overlap constraint, and so that consecutive day or
 * week windows neither double-count an appointment nor drop one.
 *
 * The audit row carries NO client_id — like `listClients`, this is a list view
 * across clients, so attributing it to one of them would be false. Spec §5:
 * one row for the view, not one per appointment.
 */
export function listCalendar(userId: string, from: string, to: string): Promise<Appointment[]> {
  assertInterval(from, to)
  return withUser(userId, async (tx) => {
    // No membership → RLS exposes no rows, so no access happened and there is
    // nothing to log. Matches listClients, including why it must not throw.
    const tenantId = await callerTenantIdOrNull(tx)
    if (!tenantId) return []

    const rows = await tx
      .select()
      .from(appointments)
      .where(and(gte(appointments.startsAt, instant(from)), lt(appointments.startsAt, instant(to))))
      .orderBy(asc(appointments.startsAt))

    await recordAudit(tx, {
      action: 'view',
      entity: 'appointment',
      entityId: null,
      clientId: null,
      metadata: { count: rows.length },
      tenantId,
    })
    return rows
  })
}

/**
 * Move an appointment. Returns null when it is not reachable; throws
 * `AppointmentOverlapError` when the new slot is taken.
 *
 * The old slot is freed by the same UPDATE that claims the new one, so moving
 * an appointment one hour later cannot conflict with itself — the exclusion
 * constraint compares the row against the OTHER rows, not its own prior value.
 */
export async function rescheduleAppointment(
  userId: string,
  appointmentId: string,
  startsAt: string,
  endsAt: string,
): Promise<Appointment | null> {
  assertInterval(startsAt, endsAt)

  return withUser(userId, async (tx) => {
    let rows: Appointment[]
    try {
      rows = await tx
        .update(appointments)
        .set({ startsAt: instant(startsAt), endsAt: instant(endsAt), updatedAt: dbNow })
        .where(eq(appointments.id, appointmentId))
        .returning()
    } catch (err) {
      if (isOverlap(err)) throw new AppointmentOverlapError()
      throw err
    }

    if (rows.length === 0) {
      // A miss is indistinguishable from a cross-tenant probe: RLS filters both
      // to the same empty result.
      await recordDeny(tx, 'appointment')
      return null
    }

    await recordAudit(tx, {
      action: 'update',
      entity: 'appointment',
      entityId: rows[0].id,
      clientId: rows[0].clientId,
      metadata: { rescheduled: true },
      tenantId: rows[0].tenantId,
    })
    return rows[0]
  })
}

/**
 * Record the outcome: completed, cancelled, or no_show.
 *
 * This is how an appointment is removed from the calendar — there is no delete
 * path. `cancelled` and `no_show` are findings about the practice (one is the
 * client telling you, the other is finding out at the appointment time), and a
 * deleted row destroys both. Cancelling also frees the slot, because
 * `appointments_no_overlap` is partial on the statuses that still occupy it.
 */
export async function setAppointmentStatus(
  userId: string,
  appointmentId: string,
  status: AppointmentStatus,
): Promise<Appointment | null> {
  assertStatus(status)

  return withUser(userId, async (tx) => {
    let rows: Appointment[]
    try {
      rows = await tx
        .update(appointments)
        .set({ status, updatedAt: dbNow })
        .where(eq(appointments.id, appointmentId))
        .returning()
    } catch (err) {
      // Re-activating a cancelled appointment whose slot was given away lands
      // here: the row re-enters the partial index and collides.
      if (isOverlap(err)) throw new AppointmentOverlapError()
      throw err
    }

    if (rows.length === 0) {
      await recordDeny(tx, 'appointment')
      return null
    }

    await recordAudit(tx, {
      action: 'update',
      entity: 'appointment',
      entityId: rows[0].id,
      clientId: rows[0].clientId,
      metadata: { status },
      tenantId: rows[0].tenantId,
    })
    return rows[0]
  })
}
