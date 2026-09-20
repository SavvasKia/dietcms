/**
 * measurements: tenant isolation, the audit trail, and the DB-level guards.
 *
 * Seeded and reaped through the OWNER client (`db`, BYPASSRLS); every
 * request-path assertion goes through the service functions, which run under
 * `withUser` / authenticated_backend, where RLS applies. The distinction
 * matters in both directions here — an owner read is the only way to tell
 * "the row was deleted" from "the row is invisible to this caller", and an
 * owner WRITE is the only way to reach the CHECK constraints, because
 * recordMeasurement's own guard would reject the input first.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { tenants, tenantMembers, clients, measurements, auditLog } from '../../db/schema'
import { createClient, softDeleteClient } from '../../lib/clients'
import {
  bmi,
  deleteMeasurement,
  listMeasurements,
  recordMeasurement,
} from '../../lib/measurements'

type Measurement = typeof measurements.$inferSelect

const run = `${Date.now().toString(36)}-meas`
const userA = `meas-a-${run}`
const userB = `meas-b-${run}`
let tenantIdA: string
let tenantIdB: string
let clientA: string
let clientB: string

async function seed(label: string, userIds: string[]): Promise<string> {
  const [t] = await db.insert(tenants).values({ name: label }).returning()
  await db
    .insert(tenantMembers)
    .values(userIds.map((userId) => ({ userId, tenantId: t.id, role: 'owner' })))
  return t.id
}

/** Dependency order: audit_log first (no FK, and the request role has no DELETE
 *  grant, so only this owner path can clear it), then the children of clients. */
async function reap(tenantId: string, userIds: string[]) {
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId))
  for (const userId of userIds) {
    await db.delete(auditLog).where(eq(auditLog.actorUserId, userId))
  }
  await db.delete(measurements).where(eq(measurements.tenantId, tenantId))
  await db.delete(clients).where(eq(clients.tenantId, tenantId))
  for (const userId of userIds) {
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, userId))
  }
  await db.delete(tenants).where(eq(tenants.id, tenantId))
}

/** Owner-path read: sees every row regardless of RLS. */
function rowsFor(clientId: string): Promise<Measurement[]> {
  return db.select().from(measurements).where(eq(measurements.clientId, clientId))
}

function denies(tenantId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'deny')))
}

beforeAll(async () => {
  tenantIdA = await seed(`MEAS A ${run}`, [userA])
  tenantIdB = await seed(`MEAS B ${run}`, [userB])
  clientA = (await createClient(userA, { firstName: 'Anna', lastName: 'P' })).id
  clientB = (await createClient(userB, { firstName: 'Boris', lastName: 'K' })).id
})
afterAll(async () => {
  await reap(tenantIdA, [userA])
  await reap(tenantIdB, [userB])
})

describe('recordMeasurement', () => {
  it('stores the metrics as numbers and audits without the values', async () => {
    const row = await recordMeasurement(userA, clientA, {
      measuredAt: '2026-04-02T08:30:00Z',
      weightKg: 78.25,
      heightCm: 181.5,
      notes: 'fasted',
    })
    expect(row).not.toBeNull()
    expect(row!.tenantId).toBe(tenantIdA)
    expect(row!.clientId).toBe(clientA)
    // numeric(mode: 'number'): drizzle's DEFAULT mapping for numeric is a
    // STRING, so this assertion is what pins the column config. 78.25 also
    // survives the round trip exactly, which a float column would not promise.
    expect(row!.weightKg).toBe(78.25)
    expect(row!.heightCm).toBe(181.5)
    expect(row!.bodyFatPct).toBeNull()
    // The ISO string was cast in SQL rather than parsed with `new Date`.
    expect(row!.measuredAt.toISOString()).toBe('2026-04-02T08:30:00.000Z')

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'measurement'), eq(auditLog.entityId, row!.id)))
    expect(audit.action).toBe('create')
    expect(audit.clientId).toBe(clientA)
    expect(audit.actorUserId).toBe(userA)
    // A COUNT, never the values: audit rows survive erasure, so a weight in
    // metadata would be health data that Art 17 can no longer remove. The
    // PII denylist would reject a `weight` KEY; nothing but this assertion
    // stops the values being smuggled under an innocuous one.
    expect(audit.metadata).toEqual({ metrics: 2 })
  })

  it('defaults measured_at to the DB clock when the caller gives none', async () => {
    const before = new Date()
    const row = await recordMeasurement(userA, clientA, { weightKg: 77 })
    expect(row!.measuredAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 60_000)
    await db.delete(measurements).where(eq(measurements.id, row!.id))
  })

  it('refuses a row with no metric before opening a transaction', async () => {
    const before = (await rowsFor(clientA)).length
    await expect(recordMeasurement(userA, clientA, { notes: 'just a note' })).rejects.toThrow(
      /at least one metric/,
    )
    // A note alone is not an observation, and the rejection must not have
    // written anything — not the row, and not a deny row either, because
    // nothing was denied: the input was invalid.
    expect(await rowsFor(clientA)).toHaveLength(before)
  })

  it("cannot attach a measurement to another tenant's client", async () => {
    const beforeDenies = (await denies(tenantIdB)).length
    // The FK to clients.id is satisfied by ANY existing client and the WITH
    // CHECK only validates tenant_id (the caller's own), so without
    // reachableClient this insert SUCCEEDS and plants a row in tenant B
    // referencing tenant A's client — a foreign identifier the victim can
    // neither see nor erase.
    expect(await recordMeasurement(userB, clientA, { weightKg: 99 })).toBeNull()
    expect(await rowsFor(clientA)).not.toContainEqual(
      expect.objectContaining({ tenantId: tenantIdB }),
    )

    const rows = await denies(tenantIdB)
    expect(rows).toHaveLength(beforeDenies + 1)
    const deny = rows[rows.length - 1]
    expect(deny.entity).toBe('measurement') // not 'client' — what was reached for
    expect(deny.tenantId).toBe(tenantIdB) // the caller's tenant, not the victim's
    expect(deny.entityId).toBeNull()
    expect(deny.clientId).toBeNull() // the probed uuid is never retained
  })

  it('refuses a soft-deleted client', async () => {
    const doomed = (await createClient(userA, { firstName: 'Soft', lastName: 'D' })).id
    await softDeleteClient(userA, doomed)
    expect(await recordMeasurement(userA, doomed, { weightKg: 70 })).toBeNull()
    expect(await rowsFor(doomed)).toHaveLength(0)
  })
})

describe('listMeasurements', () => {
  const dated = ['2026-01-10T10:00:00Z', '2026-05-20T10:00:00Z', '2026-03-15T10:00:00Z']
  let listClient: string

  beforeAll(async () => {
    listClient = (await createClient(userA, { firstName: 'List', lastName: 'M' })).id
    for (const measuredAt of dated) {
      await recordMeasurement(userA, listClient, { measuredAt, weightKg: 80 })
    }
  })

  it('returns the history newest first', async () => {
    const rows = await listMeasurements(userA, listClient)
    expect(rows.map((r) => r.measuredAt.toISOString())).toEqual([
      '2026-05-20T10:00:00.000Z',
      '2026-03-15T10:00:00.000Z',
      '2026-01-10T10:00:00.000Z',
    ])
  })

  it('writes ONE view audit row for the list, not one per measurement', async () => {
    const views = () =>
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entity, 'measurement'), eq(auditLog.clientId, listClient)))
        .then((rows) => rows.filter((r) => r.action === 'view'))
    const before = (await views()).length
    await listMeasurements(userA, listClient)
    const after = await views()
    expect(after).toHaveLength(before + 1)
    expect(after[after.length - 1].entityId).toBeNull()
    expect(after[after.length - 1].metadata).toEqual({ count: 3 })
  })

  it("returns nothing for another tenant's client and denies", async () => {
    const before = (await denies(tenantIdB)).length
    expect(await listMeasurements(userB, listClient)).toEqual([])
    expect(await denies(tenantIdB)).toHaveLength(before + 1)
  })
})

describe('deleteMeasurement', () => {
  it('deletes, audits, and is not repeatable', async () => {
    const row = await recordMeasurement(userA, clientA, { weightKg: 101 })
    expect(await deleteMeasurement(userA, row!.id)).toBe(true)
    expect(await db.select().from(measurements).where(eq(measurements.id, row!.id))).toHaveLength(0)

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'delete'), eq(auditLog.entityId, row!.id)))
    // The row is gone but the fact of its deletion is not: entity_id and
    // client_id are retained, unlike an erasure, which nulls both.
    expect(audit.entity).toBe('measurement')
    expect(audit.clientId).toBe(clientA)
    expect(audit.tenantId).toBe(tenantIdA)

    // A second call matches nothing, so it must report false and must NOT
    // append a second delete row.
    const beforeDenies = (await denies(tenantIdA)).length
    expect(await deleteMeasurement(userA, row!.id)).toBe(false)
    expect(await denies(tenantIdA)).toHaveLength(beforeDenies + 1)
  })

  it("cannot delete another tenant's measurement", async () => {
    const row = await recordMeasurement(userB, clientB, { weightKg: 66 })
    expect(await deleteMeasurement(userA, row!.id)).toBe(false)
    // RLS filtered the DELETE's own predicate — the row is still there.
    expect(await db.select().from(measurements).where(eq(measurements.id, row!.id))).toHaveLength(1)
    await db.delete(measurements).where(eq(measurements.id, row!.id))
  })
})

/**
 * The DB-level guards, reached through the OWNER connection.
 *
 * recordMeasurement's own checks would reject all of this before it ever got
 * near Postgres, which is exactly why these go around it: the point is that the
 * constraint holds for a caller who does NOT come through lib/measurements.ts.
 * Without this section, "the service validates" is the only thing proven, and
 * the CHECKs could be absent from the migration entirely.
 */
describe('DB-level constraints', () => {
  it('rejects a row with every metric null (measurements_not_empty)', async () => {
    await expect(
      db.insert(measurements).values({ tenantId: tenantIdA, clientId: clientA, notes: 'empty' }),
    ).rejects.toThrow(/measurements_not_empty/)
  })

  it('rejects an out-of-range weight, height and body fat', async () => {
    const base = { tenantId: tenantIdA, clientId: clientA }
    await expect(
      db.insert(measurements).values({ ...base, weightKg: 0 }),
    ).rejects.toThrow(/measurements_weight_kg_range/)
    await expect(
      db.insert(measurements).values({ ...base, heightCm: 301 }),
    ).rejects.toThrow(/measurements_height_cm_range/)
    await expect(
      db.insert(measurements).values({ ...base, bodyFatPct: 101 }),
    ).rejects.toThrow(/measurements_body_fat_pct_range/)
  })

  it('cascades from clients, so an erased client leaves no measurement behind', async () => {
    const doomed = (await createClient(userA, { firstName: 'Cascade', lastName: 'C' })).id
    await recordMeasurement(userA, doomed, { weightKg: 55 })
    expect(await rowsFor(doomed)).toHaveLength(1)
    // eraseClient deletes measurements EXPLICITLY; this proves the constraint
    // would have caught it anyway, so a future path that deletes a client
    // without going through lib/gdpr.ts cannot orphan health data.
    await db.delete(clients).where(eq(clients.id, doomed))
    expect(await rowsFor(doomed)).toHaveLength(0)
  })
})

/** bmi() is pure and covered exhaustively in tests/unit/measurements.test.ts.
 *  This asserts only that it agrees with what was actually persisted — that the
 *  numeric columns come back as numbers, not strings that would make the
 *  division produce NaN. */
describe('bmi over a stored row', () => {
  it('derives from the round-tripped values', async () => {
    const row = await recordMeasurement(userA, clientA, { weightKg: 70, heightCm: 175 })
    expect(bmi(row!.weightKg, row!.heightCm)).toBe(22.9)
    await db.delete(measurements).where(eq(measurements.id, row!.id))
  })
})
