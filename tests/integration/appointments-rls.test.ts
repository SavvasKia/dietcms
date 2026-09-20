/**
 * appointments: tenant isolation, the audit trail, and `appointments_no_overlap`.
 *
 * The overlap constraint is the reason most of this file exists. It is
 * hand-written SQL in migration 0010 — drizzle-kit cannot express an EXCLUDE
 * constraint, so no schema gate can see it, and
 * tests/unit/appointment-constraints.test.ts can only prove the STATEMENT is
 * present. Whether Postgres actually rejects a double-booking, lets a
 * back-to-back pair through, frees the slot on cancellation and stays inside
 * one tenant is behavioural, and this is where it is proven.
 *
 * Seeded and reaped through the OWNER client (`db`, BYPASSRLS); every
 * request-path assertion goes through the service functions, which run under
 * `withUser` / authenticated_backend, where RLS applies.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { tenants, tenantMembers, clients, appointments, auditLog } from '../../db/schema'
import { createClient, softDeleteClient } from '../../lib/clients'
import {
  AppointmentOverlapError,
  listAppointments,
  listCalendar,
  rescheduleAppointment,
  scheduleAppointment,
  setAppointmentStatus,
} from '../../lib/appointments'

const run = `${Date.now().toString(36)}-appt`
const userA = `appt-a-${run}`
const userB = `appt-b-${run}`
let tenantIdA: string
let tenantIdB: string
let clientA: string
let clientA2: string
let clientB: string

/** A distinct day per concern, so one test's bookings can never collide with
 *  another's through the tenant-wide overlap constraint. */
const DAY = {
  overlap: '2027-02-01',
  reschedule: '2027-02-02',
  status: '2027-02-03',
  list: '2027-02-04',
  calendar: '2027-02-05',
  constraints: '2027-02-06',
}
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00Z`

async function seed(label: string, userIds: string[]): Promise<string> {
  const [t] = await db.insert(tenants).values({ name: label }).returning()
  await db
    .insert(tenantMembers)
    .values(userIds.map((userId) => ({ userId, tenantId: t.id, role: 'owner' })))
  return t.id
}

async function reap(tenantId: string, userIds: string[]) {
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId))
  for (const userId of userIds) {
    await db.delete(auditLog).where(eq(auditLog.actorUserId, userId))
  }
  await db.delete(appointments).where(eq(appointments.tenantId, tenantId))
  await db.delete(clients).where(eq(clients.tenantId, tenantId))
  for (const userId of userIds) {
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, userId))
  }
  await db.delete(tenants).where(eq(tenants.id, tenantId))
}

function denies(tenantId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'deny')))
}

beforeAll(async () => {
  tenantIdA = await seed(`APPT A ${run}`, [userA])
  tenantIdB = await seed(`APPT B ${run}`, [userB])
  clientA = (await createClient(userA, { firstName: 'Client', lastName: 'One' })).id
  clientA2 = (await createClient(userA, { firstName: 'Client', lastName: 'Two' })).id
  clientB = (await createClient(userB, { firstName: 'Other', lastName: 'Tenant' })).id
})
afterAll(async () => {
  await reap(tenantIdA, [userA])
  await reap(tenantIdB, [userB])
})

describe('scheduleAppointment', () => {
  it('books, defaults to scheduled, and audits without the times', async () => {
    const row = await scheduleAppointment(userA, clientA, {
      startsAt: at(DAY.overlap, '08:00'),
      endsAt: at(DAY.overlap, '09:00'),
      location: 'Room 1',
      notes: 'first visit',
    })
    expect(row).not.toBeNull()
    expect(row!.tenantId).toBe(tenantIdA)
    expect(row!.clientId).toBe(clientA)
    expect(row!.status).toBe('scheduled')
    expect(row!.startsAt.toISOString()).toBe(`${DAY.overlap}T08:00:00.000Z`)
    expect(row!.location).toBe('Room 1')

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'appointment'), eq(auditLog.entityId, row!.id)))
    expect(audit.action).toBe('create')
    expect(audit.clientId).toBe(clientA)
    // No times in metadata: WHEN a person attended a dietitian is data about
    // them, and the audit trail outlives erasure.
    expect(audit.metadata).toBeNull()
  })

  it('rejects an inverted or zero-length interval before opening a transaction', async () => {
    await expect(
      scheduleAppointment(userA, clientA, {
        startsAt: at(DAY.overlap, '12:00'),
        endsAt: at(DAY.overlap, '11:00'),
      }),
    ).rejects.toThrow(/must end after it starts/)
    await expect(
      scheduleAppointment(userA, clientA, {
        startsAt: at(DAY.overlap, '12:00'),
        endsAt: at(DAY.overlap, '12:00'),
      }),
    ).rejects.toThrow(/must end after it starts/)
  })

  it("cannot book against another tenant's client", async () => {
    const before = (await denies(tenantIdB)).length
    expect(
      await scheduleAppointment(userB, clientA, {
        startsAt: at(DAY.overlap, '20:00'),
        endsAt: at(DAY.overlap, '21:00'),
      }),
    ).toBeNull()
    const rows = await denies(tenantIdB)
    expect(rows).toHaveLength(before + 1)
    expect(rows[rows.length - 1].entity).toBe('appointment')
    expect(rows[rows.length - 1].clientId).toBeNull()
  })

  it('refuses a soft-deleted client', async () => {
    const doomed = (await createClient(userA, { firstName: 'Soft', lastName: 'Gone' })).id
    await softDeleteClient(userA, doomed)
    expect(
      await scheduleAppointment(userA, doomed, {
        startsAt: at(DAY.overlap, '21:00'),
        endsAt: at(DAY.overlap, '22:00'),
      }),
    ).toBeNull()
  })
})

describe('appointments_no_overlap', () => {
  it('rejects a second booking that overlaps the first', async () => {
    // 08:00-09:00 is already booked for clientA above. A DIFFERENT client, to
    // prove the constraint is about the practice's time and not one client's.
    await expect(
      scheduleAppointment(userA, clientA2, {
        startsAt: at(DAY.overlap, '08:30'),
        endsAt: at(DAY.overlap, '09:30'),
      }),
    ).rejects.toBeInstanceOf(AppointmentOverlapError)
  })

  it('allows a back-to-back booking', async () => {
    // The half-open '[)' range: an appointment ending at 09:00 and one starting
    // at 09:00 do not overlap. With '[]' every consecutive booking would fail.
    const row = await scheduleAppointment(userA, clientA2, {
      startsAt: at(DAY.overlap, '09:00'),
      endsAt: at(DAY.overlap, '10:00'),
    })
    expect(row).not.toBeNull()
  })

  it('lets another tenant book the very same slot', async () => {
    // `tenant_id WITH =` scopes conflicts to one practice. Without it, one
    // tenant's calendar would block another's — and the rejection would
    // disclose that a foreign tenant holds that time.
    const row = await scheduleAppointment(userB, clientB, {
      startsAt: at(DAY.overlap, '08:00'),
      endsAt: at(DAY.overlap, '09:00'),
    })
    expect(row).not.toBeNull()
    expect(row!.tenantId).toBe(tenantIdB)
  })

  it('frees the slot when the appointment is cancelled', async () => {
    const booked = await scheduleAppointment(userA, clientA, {
      startsAt: at(DAY.overlap, '14:00'),
      endsAt: at(DAY.overlap, '15:00'),
    })
    await expect(
      scheduleAppointment(userA, clientA2, {
        startsAt: at(DAY.overlap, '14:00'),
        endsAt: at(DAY.overlap, '15:00'),
      }),
    ).rejects.toBeInstanceOf(AppointmentOverlapError)

    // The constraint is PARTIAL on the statuses that still occupy the slot.
    // Without that WHERE clause, a cancelled appointment would block rebooking
    // its own time forever.
    await setAppointmentStatus(userA, booked!.id, 'cancelled')
    const rebooked = await scheduleAppointment(userA, clientA2, {
      startsAt: at(DAY.overlap, '14:00'),
      endsAt: at(DAY.overlap, '15:00'),
    })
    expect(rebooked).not.toBeNull()

    // …and un-cancelling now collides with the replacement. Surfacing that as
    // a typed error rather than a raw 23P01 is the whole point of isOverlap.
    await expect(setAppointmentStatus(userA, booked!.id, 'scheduled')).rejects.toBeInstanceOf(
      AppointmentOverlapError,
    )
  })

  it('does not treat no_show as occupying the slot', async () => {
    const missed = await scheduleAppointment(userA, clientA, {
      startsAt: at(DAY.overlap, '16:00'),
      endsAt: at(DAY.overlap, '17:00'),
    })
    await setAppointmentStatus(userA, missed!.id, 'no_show')
    const replacement = await scheduleAppointment(userA, clientA2, {
      startsAt: at(DAY.overlap, '16:00'),
      endsAt: at(DAY.overlap, '17:00'),
    })
    expect(replacement).not.toBeNull()
  })
})

describe('rescheduleAppointment', () => {
  it('moves an appointment and audits the move', async () => {
    const row = await scheduleAppointment(userA, clientA, {
      startsAt: at(DAY.reschedule, '08:00'),
      endsAt: at(DAY.reschedule, '09:00'),
    })
    const moved = await rescheduleAppointment(
      userA,
      row!.id,
      at(DAY.reschedule, '10:00'),
      at(DAY.reschedule, '11:00'),
    )
    expect(moved!.startsAt.toISOString()).toBe(`${DAY.reschedule}T10:00:00.000Z`)
    expect(moved!.updatedAt.getTime()).toBeGreaterThanOrEqual(moved!.createdAt.getTime())

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'update'), eq(auditLog.entityId, row!.id)))
    expect(audit.metadata).toEqual({ rescheduled: true })
  })

  it('can move an appointment within its own former slot', async () => {
    // The UPDATE frees the old range and claims the new one in one statement,
    // so the row cannot conflict with its own prior value. A read-then-write
    // implementation would have had to special-case this.
    const row = await scheduleAppointment(userA, clientA, {
      startsAt: at(DAY.reschedule, '13:00'),
      endsAt: at(DAY.reschedule, '14:00'),
    })
    const moved = await rescheduleAppointment(
      userA,
      row!.id,
      at(DAY.reschedule, '13:30'),
      at(DAY.reschedule, '14:30'),
    )
    expect(moved).not.toBeNull()
  })

  it('refuses to move onto a taken slot', async () => {
    const other = await scheduleAppointment(userA, clientA2, {
      startsAt: at(DAY.reschedule, '16:00'),
      endsAt: at(DAY.reschedule, '17:00'),
    })
    await expect(
      rescheduleAppointment(
        userA,
        other!.id,
        at(DAY.reschedule, '10:30'),
        at(DAY.reschedule, '11:30'),
      ),
    ).rejects.toBeInstanceOf(AppointmentOverlapError)
  })

  it("cannot move another tenant's appointment", async () => {
    const mine = await scheduleAppointment(userA, clientA, {
      startsAt: at(DAY.reschedule, '20:00'),
      endsAt: at(DAY.reschedule, '21:00'),
    })
    expect(
      await rescheduleAppointment(
        userB,
        mine!.id,
        at(DAY.reschedule, '22:00'),
        at(DAY.reschedule, '23:00'),
      ),
    ).toBeNull()
    // RLS filtered the UPDATE's own predicate — the row is unchanged.
    const [still] = await db.select().from(appointments).where(eq(appointments.id, mine!.id))
    expect(still.startsAt.toISOString()).toBe(`${DAY.reschedule}T20:00:00.000Z`)
  })
})

describe('setAppointmentStatus', () => {
  it('records the outcome and audits it', async () => {
    const row = await scheduleAppointment(userA, clientA, {
      startsAt: at(DAY.status, '08:00'),
      endsAt: at(DAY.status, '09:00'),
    })
    const done = await setAppointmentStatus(userA, row!.id, 'completed')
    expect(done!.status).toBe('completed')

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'update'), eq(auditLog.entityId, row!.id)))
    expect(audits[audits.length - 1].metadata).toEqual({ status: 'completed' })
  })

  it('rejects an unknown status before touching the database', async () => {
    const row = await scheduleAppointment(userA, clientA, {
      startsAt: at(DAY.status, '10:00'),
      endsAt: at(DAY.status, '11:00'),
    })
    await expect(
      // The cast is the point: this value arrives from JSON.parse in a route
      // handler, where the union has no force at all.
      setAppointmentStatus(userA, row!.id, 'rescheduled-maybe' as never),
    ).rejects.toThrow(/unknown appointment status/)
    const [unchanged] = await db.select().from(appointments).where(eq(appointments.id, row!.id))
    expect(unchanged.status).toBe('scheduled')
  })
})

describe('listAppointments and listCalendar', () => {
  beforeAll(async () => {
    for (const h of ['11:00', '09:00', '13:00']) {
      await scheduleAppointment(userA, clientA, {
        startsAt: at(DAY.list, h),
        endsAt: at(DAY.list, `${String(Number(h.slice(0, 2)) + 1).padStart(2, '0')}:00`),
      })
    }
  })

  it('returns one client history, earliest first, with ONE view audit row', async () => {
    const rows = (await listAppointments(userA, clientA)).filter((r) =>
      r.startsAt.toISOString().startsWith(DAY.list),
    )
    expect(rows.map((r) => r.startsAt.toISOString())).toEqual([
      `${DAY.list}T09:00:00.000Z`,
      `${DAY.list}T11:00:00.000Z`,
      `${DAY.list}T13:00:00.000Z`,
    ])

    const views = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'appointment'), eq(auditLog.clientId, clientA)))
    const listViews = views.filter((r) => r.action === 'view')
    expect(listViews.length).toBeGreaterThan(0)
    expect(listViews[listViews.length - 1].entityId).toBeNull()
  })

  it('returns the tenant calendar for a half-open window', async () => {
    const rows = await listCalendar(userA, at(DAY.list, '09:00'), at(DAY.list, '13:00'))
    // 09:00 included, 13:00 excluded — so consecutive windows neither
    // double-count an appointment nor drop one.
    expect(rows.map((r) => r.startsAt.toISOString())).toEqual([
      `${DAY.list}T09:00:00.000Z`,
      `${DAY.list}T11:00:00.000Z`,
    ])
  })

  it('the calendar audit row names no client', async () => {
    await listCalendar(userA, at(DAY.calendar, '00:00'), at(DAY.calendar, '23:00'))
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantIdA), eq(auditLog.entity, 'appointment')))
    const calendarViews = rows.filter((r) => r.action === 'view' && r.clientId === null)
    expect(calendarViews.length).toBeGreaterThan(0)
    // A list across clients cannot honestly be attributed to one of them —
    // same rule as listClients.
    expect(calendarViews[calendarViews.length - 1].entityId).toBeNull()
  })

  it("does not show another tenant's calendar", async () => {
    const rows = await listCalendar(userB, at(DAY.list, '00:00'), at(DAY.list, '23:00'))
    for (const row of rows) expect(row.tenantId).toBe(tenantIdB)
  })
})

/**
 * The DB-level guards, reached through the OWNER connection.
 *
 * The service rejects all of this first, which is exactly why these go around
 * it: the point is that the constraint holds for a caller who does not come
 * through lib/appointments.ts.
 */
describe('DB-level constraints', () => {
  it('rejects an unknown status (appointments_status_known)', async () => {
    await expect(
      db.insert(appointments).values({
        tenantId: tenantIdA,
        clientId: clientA,
        startsAt: new Date(at(DAY.constraints, '08:00')),
        endsAt: new Date(at(DAY.constraints, '09:00')),
        status: 'pencilled_in',
      }),
    ).rejects.toThrow(/appointments_status_known/)
  })

  it('rejects an inverted interval (appointments_ends_after_starts)', async () => {
    await expect(
      db.insert(appointments).values({
        tenantId: tenantIdA,
        clientId: clientA,
        startsAt: new Date(at(DAY.constraints, '10:00')),
        endsAt: new Date(at(DAY.constraints, '09:00')),
      }),
    ).rejects.toThrow(/appointments_ends_after_starts/)
  })

  it('cascades from clients', async () => {
    const doomed = (await createClient(userA, { firstName: 'Cascade', lastName: 'Appt' })).id
    await scheduleAppointment(userA, doomed, {
      startsAt: at(DAY.constraints, '15:00'),
      endsAt: at(DAY.constraints, '16:00'),
    })
    await db.delete(clients).where(eq(clients.id, doomed))
    expect(
      await db.select().from(appointments).where(eq(appointments.clientId, doomed)),
    ).toHaveLength(0)
  })
})
