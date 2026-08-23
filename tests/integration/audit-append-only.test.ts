/**
 * audit_log: append-only at the GRANT level (not just by policy), tenant
 * isolated, and written by every audited client-service operation.
 *
 * Seeds and introspects via the OWNER client (db, BYPASSRLS); all request-path
 * assertions go through withUser / authenticated_backend, where RLS applies.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { withUser } from '../../db/authed-client'
import { tenants, tenantMembers, clients, auditLog } from '../../db/schema'
import { errorChain } from '../helpers/error-chain'
import { recordAudit } from '../../lib/audit'
import {
  createClient,
  getClient,
  listClients,
  updateClient,
  softDeleteClient,
} from '../../lib/clients'

type AuditRow = typeof auditLog.$inferSelect

/** Reap everything this file seeded for one tenant, in dependency order. */
async function reap(tenantId: string, userIds: string[]) {
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId))
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

// ---------------------------------------------------------------------------
// 1. The grant/RLS shape itself. The behavioural tests below prove the CURRENT
//    path; these catch a future migration silently re-granting UPDATE/DELETE or
//    dropping FORCE, which would leave the behavioural tests green only because
//    RLS happens to filter the row out first.
// ---------------------------------------------------------------------------
describe('audit_log privilege + RLS shape', () => {
  it('authenticated_backend has INSERT+SELECT and NOT UPDATE/DELETE', async () => {
    const { rows } = await db.execute(sql`
      select privilege_type from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = 'audit_log'
        and grantee = 'authenticated_backend'`)
    const privs = rows.map((r) => String(r.privilege_type))
    expect(privs, 'no grants at all — default privileges missed the table').not.toHaveLength(0)
    expect(privs).toContain('INSERT')
    expect(privs).toContain('SELECT')
    expect(privs).not.toContain('UPDATE')
    expect(privs).not.toContain('DELETE')
  })

  it('audit_log has RLS both enabled and FORCEd', async () => {
    // ::text so the assertion cannot be fooled by a driver returning 'f' as a
    // truthy string.
    const { rows } = await db.execute(sql`
      select relrowsecurity::text as enabled, relforcerowsecurity::text as forced
      from pg_class where oid = 'public.audit_log'::regclass`)
    expect(rows[0].enabled).toBe('true')
    expect(rows[0].forced).toBe('true')
  })

  it('audit_log carries its tenant-isolation policy', async () => {
    const { rows } = await db.execute(sql`
      select policyname from pg_policies
      where schemaname = 'public' and tablename = 'audit_log'`)
    expect(rows.map((r) => String(r.policyname))).toContain('audit_log_tenant_isolation')
  })
})

// ---------------------------------------------------------------------------
// 2. Append-only behaviour on the request path.
// ---------------------------------------------------------------------------
describe('audit_log is append-only for the request role', () => {
  const run = `${Date.now().toString(36)}-ap`
  const userA = `aud-a-${run}`
  let tenantIdA: string
  let auditId: string

  beforeAll(async () => {
    tenantIdA = await seed(`AUD AP ${run}`, [userA])
    const [row] = await db
      .insert(auditLog)
      .values({ tenantId: tenantIdA, actorUserId: userA, action: 'create', entity: 'client' })
      .returning()
    auditId = row.id
  })
  afterAll(() => reap(tenantIdA, [userA]))

  it('can INSERT an audit row', async () => {
    const [row] = await withUser(userA, (tx) =>
      tx
        .insert(auditLog)
        .values({ tenantId: tenantIdA, actorUserId: userA, action: 'view', entity: 'client' })
        .returning(),
    )
    expect(row.id).toBeTruthy()
  })

  it('can SELECT its own tenant audit rows', async () => {
    const rows = await withUser(userA, (tx) => tx.select().from(auditLog))
    expect(rows.map((r) => r.id)).toContain(auditId)
  })

  it('CANNOT UPDATE an audit row (permission denied, not RLS)', async () => {
    const chain = await errorChain(() =>
      withUser(userA, (tx) =>
        tx.execute(sql`update audit_log set action = 'export' where id = ${auditId}`),
      ),
    )
    expect(chain).toMatch(/permission denied/i)
    // Prove the row is genuinely untouched — a rejected statement that had
    // already written would still satisfy the assertion above.
    const [after] = await db.select().from(auditLog).where(eq(auditLog.id, auditId))
    expect(after.action).toBe('create')
  })

  it('CANNOT DELETE an audit row (permission denied, not RLS)', async () => {
    const chain = await errorChain(() =>
      withUser(userA, (tx) => tx.execute(sql`delete from audit_log where id = ${auditId}`)),
    )
    expect(chain).toMatch(/permission denied/i)
    const still = await db.select().from(auditLog).where(eq(auditLog.id, auditId))
    expect(still).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Tenant isolation of the audit trail itself.
// ---------------------------------------------------------------------------
describe('audit_log tenant isolation', () => {
  const run = `${Date.now().toString(36)}-iso`
  const userA = `aud-iso-a-${run}`
  const userOther = `aud-iso-o-${run}`
  let tenantIdA: string
  let tenantIdOther: string
  let auditIdA: string
  let auditIdOther: string

  beforeAll(async () => {
    tenantIdA = await seed(`AUD ISO A ${run}`, [userA])
    tenantIdOther = await seed(`AUD ISO O ${run}`, [userOther])
    const [a] = await db
      .insert(auditLog)
      .values({ tenantId: tenantIdA, actorUserId: userA, action: 'view', entity: 'client' })
      .returning()
    const [o] = await db
      .insert(auditLog)
      .values({ tenantId: tenantIdOther, actorUserId: userOther, action: 'view', entity: 'client' })
      .returning()
    auditIdA = a.id
    auditIdOther = o.id
  })
  afterAll(async () => {
    await reap(tenantIdA, [userA])
    await reap(tenantIdOther, [userOther])
  })

  it("another tenant sees its own audit rows but not this tenant's", async () => {
    const rows = await withUser(userOther, (tx) => tx.select().from(auditLog))
    const ids = rows.map((r) => r.id)
    // Positive control first: without it an empty result passes for the wrong
    // reason (e.g. the policy denying everything).
    expect(ids).toContain(auditIdOther)
    expect(ids).not.toContain(auditIdA)
  })

  it('cross-tenant audit INSERT is rejected by WITH CHECK', async () => {
    const chain = await errorChain(() =>
      withUser(userOther, (tx) =>
        tx
          .insert(auditLog)
          .values({ tenantId: tenantIdA, actorUserId: userOther, action: 'view', entity: 'client' }),
      ),
    )
    expect(chain).toMatch(/row-level security/i)
  })

  it('empty userId sees zero audit rows (fail-closed)', async () => {
    const rows = await withUser('', (tx) => tx.select().from(auditLog))
    expect(rows).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. The client-service writes one audit row per audited operation.
// ---------------------------------------------------------------------------
describe('client-service audit rows (per-client operations)', () => {
  const run = `${Date.now().toString(36)}-svc`
  const userW = `aud-w-${run}`
  let tenantIdW: string

  beforeAll(async () => {
    tenantIdW = await seed(`AUD SVC ${run}`, [userW])
  })
  afterAll(() => reap(tenantIdW, [userW]))

  /** Audit rows this user can see for one client, read back under RLS. */
  function auditFor(clientId: string): Promise<AuditRow[]> {
    return withUser(userW, (tx) => tx.select().from(auditLog).where(eq(auditLog.clientId, clientId)))
  }

  it('createClient writes exactly one create row', async () => {
    const c = await createClient(userW, { firstName: 'Eleni', lastName: 'D' })
    const rows = await auditFor(c.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('create')
    expect(rows[0].entity).toBe('client')
    expect(rows[0].entityId).toBe(c.id)
    expect(rows[0].actorUserId).toBe(userW)
    expect(rows[0].tenantId).toBe(tenantIdW)
    expect(rows[0].at).toBeInstanceOf(Date)
  })

  it('getClient writes a view row', async () => {
    const c = await createClient(userW, { firstName: 'Viewed', lastName: 'V' })
    expect((await getClient(userW, c.id))?.id).toBe(c.id)
    const views = (await auditFor(c.id)).filter((r) => r.action === 'view')
    expect(views).toHaveLength(1)
    expect(views[0].entityId).toBe(c.id)
    expect(views[0].actorUserId).toBe(userW)
  })

  it('updateClient writes an update row', async () => {
    const c = await createClient(userW, { firstName: 'Patch', lastName: 'P' })
    expect((await updateClient(userW, c.id, { goals: 'lose 5kg' }))?.goals).toBe('lose 5kg')
    const updates = (await auditFor(c.id)).filter((r) => r.action === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].entityId).toBe(c.id)
  })

  it('softDeleteClient writes a delete row', async () => {
    const c = await createClient(userW, { firstName: 'Gone', lastName: 'G' })
    expect(await softDeleteClient(userW, c.id)).toBe(true)
    const deletes = (await auditFor(c.id)).filter((r) => r.action === 'delete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].entityId).toBe(c.id)
  })

  it('a no-op read/update/delete writes NO audit row', async () => {
    // Guards the "only audit what actually happened" condition: a cross-tenant
    // or unknown id must not manufacture a view/update/delete row.
    const ghost = crypto.randomUUID()
    expect(await getClient(userW, ghost)).toBeNull()
    expect(await updateClient(userW, ghost, { goals: 'x' })).toBeNull()
    expect(await softDeleteClient(userW, ghost)).toBe(false)
    expect(await auditFor(ghost)).toHaveLength(0)
  })

  it('a second softDeleteClient does not write a second delete row', async () => {
    const c = await createClient(userW, { firstName: 'Twice', lastName: 'T' })
    expect(await softDeleteClient(userW, c.id)).toBe(true)
    expect(await softDeleteClient(userW, c.id)).toBe(false)
    expect((await auditFor(c.id)).filter((r) => r.action === 'delete')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 5. listClients — one `view` row with entity_id AND client_id null (spec §5).
//    Its own tenant, because a null-client_id row cannot be filtered by client.
// ---------------------------------------------------------------------------
describe('client-service audit rows (list view)', () => {
  const run = `${Date.now().toString(36)}-lst`
  const userL = `aud-l-${run}`
  // Deliberately given no tenant_members row.
  const userNone = `aud-none-${run}`
  let tenantIdL: string

  beforeAll(async () => {
    tenantIdL = await seed(`AUD LST ${run}`, [userL])
  })
  afterAll(() => reap(tenantIdL, [userL]))

  function listAudits(): Promise<AuditRow[]> {
    return withUser(userL, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'view'), isNull(auditLog.entityId))),
    )
  }

  it('each listClients call appends exactly one client-less view row', async () => {
    await createClient(userL, { firstName: 'Listed', lastName: 'L' })
    expect(await listAudits()).toHaveLength(0) // no list call yet

    const first = await listClients(userL)
    expect(first).toHaveLength(1)
    let rows = await listAudits()
    expect(rows).toHaveLength(1)
    expect(rows[0].entity).toBe('client')
    expect(rows[0].entityId).toBeNull()
    expect(rows[0].clientId).toBeNull()
    expect(rows[0].actorUserId).toBe(userL)
    expect(rows[0].metadata).toEqual({ count: 1 })

    await listClients(userL)
    rows = await listAudits()
    expect(rows).toHaveLength(2)
  })

  it('listClients fails closed for a caller with no membership', async () => {
    // Behaviour change vs Task 2 (it returned []): the list audit row is
    // unconditional, so an unauditable list must not succeed.
    const chain = await errorChain(() => listClients(userNone))
    expect(chain).toMatch(/no tenant for user/i)
  })
})

// ---------------------------------------------------------------------------
// 6. Privacy regression (spec §7): metadata keys are checked against the
//    shared PII denylist.
// ---------------------------------------------------------------------------
describe('audit metadata PII denylist', () => {
  const run = `${Date.now().toString(36)}-pii`
  const userP = `aud-p-${run}`
  let tenantIdP: string

  beforeAll(async () => {
    tenantIdP = await seed(`AUD PII ${run}`, [userP])
  })
  afterAll(() => reap(tenantIdP, [userP]))

  it('rejects a denylisted metadata key', async () => {
    const chain = await errorChain(() =>
      withUser(userP, (tx) =>
        recordAudit(tx, {
          action: 'view',
          entity: 'client',
          metadata: { clientEmail: 'maria@example.gr' },
        }),
      ),
    )
    expect(chain).toMatch(/clientEmail/)
    expect(chain).toMatch(/denylist/i)
    const rows = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantIdP))
    expect(rows, 'the rejected row must not have been written').toHaveLength(0)
  })

  it('accepts PII-free metadata', async () => {
    await withUser(userP, (tx) =>
      recordAudit(tx, { action: 'view', entity: 'client', metadata: { count: 3 } }),
    )
    const rows = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantIdP))
    expect(rows).toHaveLength(1)
    expect(rows[0].metadata).toEqual({ count: 3 })
    expect(rows[0].actorUserId).toBe(userP)
  })
})

// ---------------------------------------------------------------------------
// 7. A failed audit write must abort the mutation it belongs to. This is the
//    property that makes the trail trustworthy: no write can be committed
//    unaudited. recordAudit shares the mutation's tx precisely for this.
// ---------------------------------------------------------------------------
describe('a failed audit write rolls back the mutation', () => {
  const run = `${Date.now().toString(36)}-rb`
  const userR = `aud-r-${run}`
  let tenantIdR: string

  beforeAll(async () => {
    tenantIdR = await seed(`AUD RB ${run}`, [userR])
  })
  afterAll(() => reap(tenantIdR, [userR]))

  /** Everything actually persisted for this tenant, read via the owner (so RLS
   *  cannot be the reason a row is missing). */
  async function persisted() {
    return {
      clients: await db.select().from(clients).where(eq(clients.tenantId, tenantIdR)),
      audits: await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantIdR)),
    }
  }

  it('a DB-level failure inside the audit INSERT rolls back the client insert', async () => {
    let insertedId: string | undefined
    const chain = await errorChain(() =>
      withUser(userR, async (tx) => {
        const [row] = await tx
          .insert(clients)
          .values({ tenantId: tenantIdR, firstName: 'Rollback', lastName: 'DB' })
          .returning()
        insertedId = row.id
        // Malformed uuid → the audit INSERT itself fails in Postgres.
        await recordAudit(tx, {
          action: 'create',
          entity: 'client',
          entityId: 'not-a-uuid',
          clientId: row.id,
        })
      }),
    )
    expect(chain).toMatch(/invalid input syntax for type uuid/i)
    expect(insertedId, 'the client insert must actually have run').toBeTruthy()

    const after = await persisted()
    expect(after.clients, 'unaudited client row was committed').toHaveLength(0)
    expect(after.audits).toHaveLength(0)
  })

  it('a denylist rejection rolls back the client insert', async () => {
    let insertedId: string | undefined
    const chain = await errorChain(() =>
      withUser(userR, async (tx) => {
        const [row] = await tx
          .insert(clients)
          .values({ tenantId: tenantIdR, firstName: 'Rollback', lastName: 'PII' })
          .returning()
        insertedId = row.id
        await recordAudit(tx, {
          action: 'create',
          entity: 'client',
          clientId: row.id,
          metadata: { patientNotes: 'leaks' },
        })
      }),
    )
    expect(chain).toMatch(/denylist/i)
    expect(insertedId).toBeTruthy()

    const after = await persisted()
    expect(after.clients).toHaveLength(0)
    expect(after.audits).toHaveLength(0)
  })
})
