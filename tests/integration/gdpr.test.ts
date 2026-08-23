/**
 * gdpr-service: export (Art 15/20) and erasure (Art 17), with the per-table
 * policy — clinical rows deleted, audit rows anonymized and retained.
 *
 * This is the module's only data-destroying path and the only one that writes
 * through the RLS-bypassing owner connection, so most of this file is spent
 * proving the blast radius rather than the happy path.
 *
 * Everything is seeded and reaped through the OWNER client (`db`, BYPASSRLS);
 * every request-path assertion goes through the service functions, which run
 * under `withUser` / authenticated_backend, where RLS applies.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/client'
import { withUser } from '../../db/authed-client'
import { tenants, tenantMembers, clients, clientConsents, auditLog } from '../../db/schema'
import { recordAudit } from '../../lib/audit'
import { createClient, getClient, softDeleteClient } from '../../lib/clients'
import { grantConsent } from '../../lib/consents'
import { exportClient, eraseClient } from '../../lib/gdpr'

type AuditRow = typeof auditLog.$inferSelect

/**
 * Reap everything one tenant seeded, in dependency order.
 *
 * `audit_log` FIRST and always: it carries no FK, so nothing cascades it, and
 * the request role has no DELETE grant — only this owner path can clear it.
 * Task 3 omitted it from one afterAll and orphaned 237 rows, which no
 * verification gate can see.
 *
 * Also deletes audit rows by ACTOR, not only by tenant: this file deliberately
 * seeds a row in one tenant that references another tenant's client, and a
 * tenant-scoped erasure cannot reach it (see the cross-reference test below).
 */
async function reap(tenantId: string, userIds: string[]) {
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId))
  for (const userId of userIds) {
    await db.delete(auditLog).where(eq(auditLog.actorUserId, userId))
  }
  await db.delete(clientConsents).where(eq(clientConsents.tenantId, tenantId))
  await db.delete(clients).where(eq(clients.tenantId, tenantId))
  for (const userId of userIds) {
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, userId))
  }
  await db.delete(tenants).where(eq(tenants.id, tenantId))
}

async function seed(label: string, userIds: string[]): Promise<string> {
  const [t] = await db.insert(tenants).values({ name: label }).returning()
  await db
    .insert(tenantMembers)
    .values(userIds.map((userId) => ({ userId, tenantId: t.id, role: 'owner' })))
  return t.id
}

/** Audit rows for one client IN one tenant, read via the OWNER so RLS can never
 *  be the reason a row looks present or absent. Tenant-qualified on purpose:
 *  the owner sees every tenant's rows, including this file's deliberate
 *  cross-tenant reference. */
function auditFor(tenantId: string, clientId: string): Promise<AuditRow[]> {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.clientId, clientId)))
}

/** Audit rows by id — the only way to find them again once erasure has nulled
 *  their `client_id`. */
function auditByIds(ids: string[]): Promise<AuditRow[]> {
  if (ids.length === 0) return Promise.resolve([])
  return db.select().from(auditLog).where(inArray(auditLog.id, ids))
}

function denies(tenantId: string): Promise<AuditRow[]> {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'deny')))
}

// ---------------------------------------------------------------------------
// 1. exportClient — completeness, the export audit row, and isolation.
// ---------------------------------------------------------------------------
describe('exportClient', () => {
  const run = `${Date.now().toString(36)}-exp`
  const userA = `gdpr-exp-a-${run}`
  const userB = `gdpr-exp-b-${run}`
  // Deliberately given no tenant_members row.
  const userNone = `gdpr-exp-n-${run}`
  let tenantIdA: string
  let tenantIdB: string
  let clientId: string

  beforeAll(async () => {
    tenantIdA = await seed(`GDPR EXP A ${run}`, [userA])
    tenantIdB = await seed(`GDPR EXP B ${run}`, [userB])
    const c = await createClient(userA, {
      firstName: 'Giorgos',
      lastName: 'V',
      email: 'giorgos@example.gr',
      notes: 'clinical note',
    })
    clientId = c.id
    await grantConsent(userA, clientId, 'email_comms', 'v1-el')
    await grantConsent(userA, clientId, 'marketing', 'v1-el')
    await getClient(userA, clientId)
  })
  afterAll(async () => {
    await reap(tenantIdA, [userA])
    await reap(tenantIdB, [userB, userNone])
  })

  it('returns the client row, its consents and its audit rows', async () => {
    const dump = await exportClient(userA, clientId)
    expect(dump).not.toBeNull()
    expect(dump?.client.id).toBe(clientId)
    // Actual field values, not just the id: an export that returned a stub
    // would satisfy an id-only assertion.
    expect(dump?.client.email).toBe('giorgos@example.gr')
    expect(dump?.client.notes).toBe('clinical note')
    expect(dump?.consents.map((c) => c.scope).sort()).toEqual(['email_comms', 'marketing'])
    // create(client) + create(consent) x2 + view = 4 at minimum.
    expect(dump!.auditLog.length).toBeGreaterThanOrEqual(4)
    for (const row of dump!.auditLog) {
      expect(row.clientId).toBe(clientId)
      expect(row.tenantId).toBe(tenantIdA)
    }
  })

  it('writes an export audit row referencing the client', async () => {
    const before = (await auditFor(tenantIdA, clientId)).filter((r) => r.action === 'export')
    await exportClient(userA, clientId)
    const after = (await auditFor(tenantIdA, clientId)).filter((r) => r.action === 'export')
    expect(after).toHaveLength(before.length + 1)
    const row = after[after.length - 1]
    expect(row.entity).toBe('client')
    // Unlike the erase row, an export row legitimately references a client that
    // still exists.
    expect(row.entityId).toBe(clientId)
    expect(row.clientId).toBe(clientId)
    expect(row.actorUserId).toBe(userA)
    expect(row.tenantId).toBe(tenantIdA)
    // PII-free scale of what was disclosed. Asserted so the shape cannot drift
    // into something the denylist would have to catch.
    expect(row.metadata).toEqual({ consents: 2, auditRows: expect.any(Number) })
    expect((row.metadata as { auditRows: number }).auditRows).toBeGreaterThanOrEqual(4)
  })

  it('a cross-tenant export returns null, denies, and discloses nothing', async () => {
    const beforeDenies = (await denies(tenantIdB)).length
    expect(await exportClient(userB, clientId)).toBeNull()

    const rows = await denies(tenantIdB)
    expect(rows).toHaveLength(beforeDenies + 1)
    const deny = rows[rows.length - 1]
    expect(deny.tenantId).toBe(tenantIdB) // the caller's tenant, not the victim's
    expect(deny.actorUserId).toBe(userB)
    expect(deny.entity).toBe('client')
    // The probed uuid is NOT retained (owner decision, carried from Task 3).
    expect(deny.entityId).toBeNull()
    expect(deny.clientId).toBeNull()
    expect(deny.metadata).toEqual({ outcome: 'denied' })

    // Nothing was disclosed into the caller's tenant, and no export row was
    // written against the victim's client.
    const exports = (await auditFor(tenantIdA, clientId)).filter(
      (r) => r.actorUserId === userB || r.tenantId === tenantIdB,
    )
    expect(exports).toHaveLength(0)
  })

  it('an unknown uuid returns null and denies', async () => {
    const before = (await denies(tenantIdA)).length
    expect(await exportClient(userA, crypto.randomUUID())).toBeNull()
    expect(await denies(tenantIdA)).toHaveLength(before + 1)
  })

  it('a membership-less caller gets null, no throw, and no audit row', async () => {
    // recordDeny cannot attribute a tenant here, so it must skip rather than
    // throw — the trap that made listClients regress in Task 3.
    expect(await exportClient(userNone, clientId)).toBeNull()
    const rows = await db.select().from(auditLog).where(eq(auditLog.actorUserId, userNone))
    expect(rows).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. eraseClient blast radius. Two clients in the caller's tenant, one in a
//    second tenant, plus an audit row in the second tenant that REFERENCES the
//    erased client — constructible on the request path, because audit_log's
//    WITH CHECK validates only tenant_id and client_id has no FK. That row is
//    what makes the owner-path statement's tenant_id predicate load-bearing:
//    without it the client_id uuid alone would reach across the tenant boundary
//    on a BYPASSRLS connection.
// ---------------------------------------------------------------------------
describe('eraseClient blast radius', () => {
  const run = `${Date.now().toString(36)}-blast`
  const userA = `gdpr-bl-a-${run}`
  const userB = `gdpr-bl-b-${run}`
  let tenantIdA: string
  let tenantIdB: string
  let erasedId: string
  let siblingId: string
  let otherTenantClientId: string
  let erasedAuditBefore: AuditRow[]
  let siblingAuditBefore: AuditRow[]
  let otherAuditBefore: AuditRow[]
  let crossRefBefore: AuditRow
  let eraseOk: boolean

  beforeAll(async () => {
    tenantIdA = await seed(`GDPR BL A ${run}`, [userA])
    tenantIdB = await seed(`GDPR BL B ${run}`, [userB])

    erasedId = (await createClient(userA, { firstName: 'Erase', lastName: 'Me', notes: 'n' })).id
    siblingId = (await createClient(userA, { firstName: 'Keep', lastName: 'Me' })).id
    otherTenantClientId = (await createClient(userB, { firstName: 'Other', lastName: 'T' })).id

    await grantConsent(userA, erasedId, 'email_comms', 'v1-el')
    await grantConsent(userA, erasedId, 'marketing', 'v1-el')
    await grantConsent(userA, siblingId, 'email_comms', 'v1-el')
    await grantConsent(userB, otherTenantClientId, 'email_comms', 'v1-el')
    await getClient(userA, erasedId)
    await getClient(userA, siblingId)

    // Tenant B logs an audit row pointing at tenant A's client. WITH CHECK only
    // validates tenant_id, so the request path accepts it.
    await withUser(userB, (tx) =>
      recordAudit(tx, {
        action: 'view',
        entity: 'client',
        entityId: erasedId,
        clientId: erasedId,
        tenantId: tenantIdB,
      }),
    )
    const [crossRef] = await auditFor(tenantIdB, erasedId)
    expect(crossRef, 'the cross-tenant reference row was not seeded').toBeTruthy()
    crossRefBefore = crossRef

    erasedAuditBefore = await auditFor(tenantIdA, erasedId)
    siblingAuditBefore = await auditFor(tenantIdA, siblingId)
    otherAuditBefore = await auditFor(tenantIdB, otherTenantClientId)
    expect(erasedAuditBefore.length).toBeGreaterThan(0)
    expect(siblingAuditBefore.length).toBeGreaterThan(0)
    expect(otherAuditBefore.length).toBeGreaterThan(0)

    eraseOk = await eraseClient(userA, erasedId)
  })
  afterAll(async () => {
    await reap(tenantIdA, [userA])
    await reap(tenantIdB, [userB])
  })

  it('reports success and destroys the clinical rows', async () => {
    expect(eraseOk).toBe(true)
    expect(await db.select().from(clients).where(eq(clients.id, erasedId))).toHaveLength(0)
    expect(
      await db.select().from(clientConsents).where(eq(clientConsents.clientId, erasedId)),
    ).toHaveLength(0)
  })

  it('anonymizes the erased client audit rows but retains them intact', async () => {
    const after = await auditByIds(erasedAuditBefore.map((r) => r.id))
    expect(after, 'audit rows were deleted, not anonymized').toHaveLength(
      erasedAuditBefore.length,
    )
    const byId = new Map(after.map((r) => [r.id, r]))
    for (const before of erasedAuditBefore) {
      const now = byId.get(before.id)!
      // The three data-subject references are gone…
      expect(now.clientId).toBeNull()
      expect(now.entityId).toBeNull()
      expect(now.metadata).toBeNull()
      // …and everything the audit obligation needs is retained.
      expect(now.action).toBe(before.action)
      expect(now.entity).toBe(before.entity)
      expect(now.actorUserId).toBe(before.actorUserId)
      expect(now.tenantId).toBe(before.tenantId)
      expect(now.at.getTime()).toBe(before.at.getTime())
    }
  })

  it('writes a final erase row carrying NO client reference', async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantIdA), eq(auditLog.action, 'erase')))
    expect(rows).toHaveLength(1)
    expect(rows[0].entity).toBe('client')
    // Spec §5 (no client PII) and, with the corrected ordering, the erase row is
    // written AFTER anonymization — a populated client_id here would be a fresh
    // dangling reference to the row just deleted.
    expect(rows[0].entityId).toBeNull()
    expect(rows[0].clientId).toBeNull()
    expect(rows[0].metadata).toBeNull()
    // Deviation from spec §5's "actor=system": the acting user is the
    // controller's staff, not the data subject. Accountability is retained.
    expect(rows[0].actorUserId).toBe(userA)
    expect(rows[0].tenantId).toBe(tenantIdA)
  })

  it('leaves the sibling client in the SAME tenant completely untouched', async () => {
    const after = await auditFor(tenantIdA, siblingId)
    expect(after).toHaveLength(siblingAuditBefore.length)
    const byId = new Map(after.map((r) => [r.id, r]))
    for (const before of siblingAuditBefore) {
      const now = byId.get(before.id)
      expect(now, 'a sibling audit row lost its client_id').toBeTruthy()
      expect(now!.entityId).toBe(before.entityId)
      expect(now!.metadata).toEqual(before.metadata)
    }
    // And its clinical rows survive.
    expect(await db.select().from(clients).where(eq(clients.id, siblingId))).toHaveLength(1)
    expect(
      await db.select().from(clientConsents).where(eq(clientConsents.clientId, siblingId)),
    ).toHaveLength(1)
  })

  it("leaves the second tenant's own rows untouched", async () => {
    const after = await auditFor(tenantIdB, otherTenantClientId)
    expect(after).toHaveLength(otherAuditBefore.length)
    for (const row of after) {
      expect(row.clientId).toBe(otherTenantClientId)
      expect(row.entityId).not.toBeNull()
    }
    expect(
      await db.select().from(clients).where(eq(clients.id, otherTenantClientId)),
    ).toHaveLength(1)
  })

  it("does NOT reach the second tenant's row that references the erased client", async () => {
    // The tenant_id predicate on the owner-path UPDATE is the only thing
    // stopping this: client_id alone is a globally unique uuid, so a
    // client_id-only WHERE would anonymize a foreign tenant's row through a
    // BYPASSRLS connection. Drop that predicate and this assertion fails.
    const [now] = await auditByIds([crossRefBefore.id])
    expect(now, 'the cross-tenant reference row was deleted').toBeTruthy()
    expect(now.tenantId).toBe(tenantIdB)
    expect(now.clientId).toBe(erasedId)
    expect(now.entityId).toBe(erasedId)
  })
})

// ---------------------------------------------------------------------------
// 3. Cross-tenant erasure. The single most important assertion in this file:
//    a denied erase must destroy NOTHING.
// ---------------------------------------------------------------------------
describe('eraseClient cross-tenant', () => {
  const run = `${Date.now().toString(36)}-xt`
  const userD = `gdpr-xt-d-${run}` // the caller doing the erasing
  const userV = `gdpr-xt-v-${run}` // the victim who owns the client
  // Deliberately given no tenant_members row.
  const userNone = `gdpr-xt-n-${run}`
  let tenantIdD: string
  let tenantIdV: string
  let victimClientId: string
  let victimAuditBefore: AuditRow[]

  beforeAll(async () => {
    tenantIdD = await seed(`GDPR XT D ${run}`, [userD])
    tenantIdV = await seed(`GDPR XT V ${run}`, [userV])
    victimClientId = (
      await createClient(userV, { firstName: 'Victim', lastName: 'V', notes: 'private' })
    ).id
    await grantConsent(userV, victimClientId, 'email_comms', 'v1-el')
    await getClient(userV, victimClientId)
    victimAuditBefore = await auditFor(tenantIdV, victimClientId)
    expect(victimAuditBefore.length).toBeGreaterThan(0)
  })
  afterAll(async () => {
    await reap(tenantIdD, [userD])
    await reap(tenantIdV, [userV, userNone])
  })

  it('returns false, denies in the CALLER tenant, and deletes NOTHING', async () => {
    const beforeDenies = (await denies(tenantIdD)).length

    expect(await eraseClient(userD, victimClientId)).toBe(false)

    const rows = await denies(tenantIdD)
    expect(rows).toHaveLength(beforeDenies + 1)
    const deny = rows[rows.length - 1]
    expect(deny.tenantId).toBe(tenantIdD)
    expect(deny.actorUserId).toBe(userD)
    expect(deny.entityId).toBeNull()
    expect(deny.clientId).toBeNull()

    // THE assertion: the victim's data is entirely intact.
    const client = await db.select().from(clients).where(eq(clients.id, victimClientId))
    expect(client, "the victim's client row was DELETED").toHaveLength(1)
    expect(client[0].notes).toBe('private')
    expect(
      await db.select().from(clientConsents).where(eq(clientConsents.clientId, victimClientId)),
      "the victim's consents were DELETED",
    ).toHaveLength(1)

    const after = await auditByIds(victimAuditBefore.map((r) => r.id))
    expect(after, "the victim's audit rows were DELETED").toHaveLength(victimAuditBefore.length)
    const byId = new Map(after.map((r) => [r.id, r]))
    for (const before of victimAuditBefore) {
      const now = byId.get(before.id)!
      expect(now.clientId, "the victim's audit row was ANONYMIZED").toBe(before.clientId)
      expect(now.entityId).toBe(before.entityId)
      expect(now.metadata).toEqual(before.metadata)
    }
    // No erase row was written in either tenant.
    const erases = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'erase'),
          inArray(auditLog.tenantId, [tenantIdD, tenantIdV]),
        ),
      )
    expect(erases).toHaveLength(0)
  })

  it('an unknown uuid returns false and denies', async () => {
    const before = (await denies(tenantIdD)).length
    expect(await eraseClient(userD, crypto.randomUUID())).toBe(false)
    expect(await denies(tenantIdD)).toHaveLength(before + 1)
  })

  it('a membership-less caller gets false, no throw, and no audit row', async () => {
    expect(await eraseClient(userNone, victimClientId)).toBe(false)
    const rows = await db.select().from(auditLog).where(eq(auditLog.actorUserId, userNone))
    expect(rows).toHaveLength(0)
    // Still nothing destroyed.
    expect(await db.select().from(clients).where(eq(clients.id, victimClientId))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Soft-deleted clients (Task 4 handoff). A soft delete is exactly what
//    precedes an erasure request, so both entry points must still reach the
//    client — and the consent read must NOT go through lib/consents.ts, whose
//    reachableClient filters deleted_at and would return [] plus a deny row.
// ---------------------------------------------------------------------------
describe('exportClient / eraseClient reach a SOFT-DELETED client', () => {
  const run = `${Date.now().toString(36)}-soft`
  const userS = `gdpr-sd-${run}`
  let tenantIdS: string
  let clientId: string

  beforeAll(async () => {
    tenantIdS = await seed(`GDPR SD ${run}`, [userS])
    clientId = (await createClient(userS, { firstName: 'Soft', lastName: 'Gone' })).id
    await grantConsent(userS, clientId, 'email_comms', 'v1-el')
    expect(await softDeleteClient(userS, clientId)).toBe(true)
  })
  afterAll(() => reap(tenantIdS, [userS]))

  it('exportClient returns the full record INCLUDING consents', async () => {
    const dump = await exportClient(userS, clientId)
    expect(dump, 'a soft-deleted client was treated as unreachable').not.toBeNull()
    expect(dump?.client.id).toBe(clientId)
    expect(dump?.client.deletedAt).not.toBeNull()
    // The lib/consents.ts trap: routing through activeConsents would yield [].
    expect(dump?.consents.map((c) => c.scope)).toEqual(['email_comms'])
  })

  it('writes no deny row for a soft-deleted client', async () => {
    expect(await denies(tenantIdS)).toHaveLength(0)
  })

  it('eraseClient succeeds on a soft-deleted client', async () => {
    expect(await eraseClient(userS, clientId)).toBe(true)
    expect(await db.select().from(clients).where(eq(clients.id, clientId))).toHaveLength(0)
    expect(
      await db.select().from(clientConsents).where(eq(clientConsents.clientId, clientId)),
    ).toHaveLength(0)
    expect(await denies(tenantIdS)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Second call on an already-erased client: unreachable like any other miss.
// ---------------------------------------------------------------------------
describe('eraseClient is not re-runnable', () => {
  const run = `${Date.now().toString(36)}-idem`
  const userI = `gdpr-id-${run}`
  let tenantIdI: string
  let clientId: string
  let afterFirst: AuditRow[]

  beforeAll(async () => {
    tenantIdI = await seed(`GDPR IDEM ${run}`, [userI])
    clientId = (await createClient(userI, { firstName: 'Once', lastName: 'Only' })).id
    await grantConsent(userI, clientId, 'email_comms', 'v1-el')
    expect(await eraseClient(userI, clientId)).toBe(true)
    afterFirst = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantIdI))
  })
  afterAll(() => reap(tenantIdI, [userI]))

  it('a second call returns false, does not throw, and only adds a deny row', async () => {
    expect(await eraseClient(userI, clientId)).toBe(false)

    const now = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantIdI))
    expect(now).toHaveLength(afterFirst.length + 1)
    const added = now.filter((r) => !afterFirst.some((b) => b.id === r.id))
    expect(added).toHaveLength(1)
    expect(added[0].action).toBe('deny')

    // Nothing was re-anonymized or otherwise rewritten.
    const byId = new Map(now.map((r) => [r.id, r]))
    for (const before of afterFirst) {
      const row = byId.get(before.id)!
      expect(row.action).toBe(before.action)
      expect(row.clientId).toBe(before.clientId)
      expect(row.entityId).toBe(before.entityId)
      expect(row.metadata).toEqual(before.metadata)
    }
    // Exactly one erase row, still.
    expect(now.filter((r) => r.action === 'erase')).toHaveLength(1)
  })
})
