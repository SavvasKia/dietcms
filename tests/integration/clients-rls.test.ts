/** clients RLS isolation (Path B). Seeds via owner; asserts via withUser. */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { db } from '../../db/client'
import { withUser } from '../../db/authed-client'
import { tenants, tenantMembers, clients, auditLog } from '../../db/schema'
import { eq, or } from 'drizzle-orm'
import {
  createClient,
  getClient,
  listClients,
  updateClient,
  softDeleteClient,
} from '../../lib/clients'
import { errorChain } from '../helpers/error-chain'

const run = Date.now().toString(36)
const userA = `cli-a-${run}`
const userB = `cli-b-${run}`
let tenantIdA: string
let tenantIdB: string
let clientIdA: string

describe('clients RLS isolation', () => {
  beforeAll(async () => {
    const [tA] = await db.insert(tenants).values({ name: `CT A ${run}` }).returning()
    const [tB] = await db.insert(tenants).values({ name: `CT B ${run}` }).returning()
    tenantIdA = tA.id
    tenantIdB = tB.id
    await db.insert(tenantMembers).values([
      { userId: userA, tenantId: tenantIdA, role: 'owner' },
      { userId: userB, tenantId: tenantIdB, role: 'owner' },
    ])
  })

  afterAll(async () => {
    await db.delete(clients).where(or(eq(clients.tenantId, tenantIdA), eq(clients.tenantId, tenantIdB)))
    await db.delete(tenantMembers).where(or(eq(tenantMembers.userId, userA), eq(tenantMembers.userId, userB)))
    await db.delete(tenants).where(or(eq(tenants.id, tenantIdA), eq(tenants.id, tenantIdB)))
  })

  it('userA inserts a client into their own tenant', async () => {
    const [row] = await withUser(userA, (tx) =>
      tx.insert(clients).values({ tenantId: tenantIdA, firstName: 'Maria', lastName: 'P' }).returning(),
    )
    expect(row.id).toBeTruthy()
    clientIdA = row.id
  })

  it('userA sees their own client', async () => {
    expect(clientIdA).toBeTruthy() // guard: without it the isolation assertions pass vacuously
    const rows = await withUser(userA, (tx) => tx.select().from(clients))
    expect(rows.map((r) => r.id)).toContain(clientIdA)
  })

  it("userB does NOT see userA's client", async () => {
    expect(clientIdA).toBeTruthy() // guard: not.toContain(undefined) would pass on a broken insert
    const rows = await withUser(userB, (tx) => tx.select().from(clients))
    expect(rows.map((r) => r.id)).not.toContain(clientIdA)
  })

  it('cross-tenant insert is rejected by WITH CHECK', async () => {
    // Match the RLS error specifically: a bare toThrow() also passes on
    // permission denied / NOT NULL violations / network failure.
    const chain = await errorChain(() =>
      withUser(userB, (tx) =>
        tx.insert(clients).values({ tenantId: tenantIdA, firstName: 'evil', lastName: 'x' }),
      ),
    )
    expect(chain).toMatch(/row-level security/i)
  })

  it('empty userId sees zero rows (fail-closed)', async () => {
    const rows = await withUser('', (tx) => tx.select().from(clients))
    expect(rows.length).toBe(0)
  })
})

describe('client-service', () => {
  const run2 = `${Date.now().toString(36)}-svc`
  const userS = `cli-s-${run2}`
  const userOther = `cli-o-${run2}`
  // Deliberately never given a tenant_members row: exercises the fail-closed path.
  const userNone = `cli-none-${run2}`
  let tenantIdS: string
  let tenantIdOther: string

  beforeAll(async () => {
    const [tS] = await db.insert(tenants).values({ name: `CT S ${run2}` }).returning()
    const [tO] = await db.insert(tenants).values({ name: `CT O ${run2}` }).returning()
    tenantIdS = tS.id
    tenantIdOther = tO.id
    await db.insert(tenantMembers).values([
      { userId: userS, tenantId: tenantIdS, role: 'owner' },
      { userId: userOther, tenantId: tenantIdOther, role: 'owner' },
    ])
  })

  afterAll(async () => {
    // Owner role (BYPASSRLS) — also reaps the soft-deleted rows, which are still physically present.
    // audit_log first: the service now writes a row per operation, audit_log.tenant_id
    // has no FK (deliberate — see db/schema.ts), and the request role has no DELETE
    // grant, so only this owner path can ever reap them.
    await db
      .delete(auditLog)
      .where(or(eq(auditLog.tenantId, tenantIdS), eq(auditLog.tenantId, tenantIdOther)))
    await db
      .delete(clients)
      .where(or(eq(clients.tenantId, tenantIdS), eq(clients.tenantId, tenantIdOther)))
    await db
      .delete(tenantMembers)
      .where(or(eq(tenantMembers.userId, userS), eq(tenantMembers.userId, userOther)))
    await db.delete(tenants).where(or(eq(tenants.id, tenantIdS), eq(tenants.id, tenantIdOther)))
  })

  it('createClient sets tenant_id from the caller and returns the row', async () => {
    const c = await createClient(userS, { firstName: 'Nikos', lastName: 'K', allergies: ['peanuts'] })
    expect(c.id).toBeTruthy()
    expect(c.tenantId).toBe(tenantIdS)
    expect(c.allergies).toEqual(['peanuts'])
    expect(c.lawfulBasis).toBe('art_9_2_h_healthcare')
    expect(c.deletedAt).toBeNull()
  })

  it('createClient fails closed when the caller has no tenant membership', async () => {
    // The only throwing path in the service. Match the real message through the
    // cause chain — a bare toThrow() would also pass on permission-denied.
    const chain = await errorChain(() =>
      createClient(userNone, { firstName: 'Ghost', lastName: 'X' }),
    )
    expect(chain).toMatch(/no tenant for user/i)
  })

  it('getClient returns the created client', async () => {
    const created = await createClient(userS, { firstName: 'Eleni', lastName: 'V' })
    const c = await getClient(userS, created.id)
    expect(c?.id).toBe(created.id)
    expect(c?.firstName).toBe('Eleni')
  })

  it('getClient returns null for an unknown uuid (does not throw)', async () => {
    expect(await getClient(userS, crypto.randomUUID())).toBeNull()
  })

  it('listClients returns the caller own live clients', async () => {
    const created = await createClient(userS, { firstName: 'Listed', lastName: 'L' })
    const rows = await listClients(userS)
    expect(rows.map((r) => r.id)).toContain(created.id)
    expect(rows.every((r) => r.tenantId === tenantIdS)).toBe(true)
    expect(rows.every((r) => r.deletedAt === null)).toBe(true)
  })

  it('updateClient patches fields and bumps updatedAt', async () => {
    const created = await createClient(userS, { firstName: 'Patch', lastName: 'P', goals: 'maintain' })
    const c = await updateClient(userS, created.id, { goals: 'lose 5kg' })
    expect(c?.goals).toBe('lose 5kg')
    expect(c?.firstName).toBe('Patch') // unpatched fields survive
    // No DB trigger maintains updated_at — the service is the only writer, so
    // this is the only proof it happened. Both sides are the DB clock (create
    // uses defaultNow(), the patch uses now()), so the delta cannot be eaten by
    // app/DB clock skew: the update transaction simply starts later.
    const delta = c!.updatedAt.getTime() - created.updatedAt.getTime()
    expect(delta, `updatedAt did not advance (delta ${delta}ms)`).toBeGreaterThan(0)
    expect(c!.createdAt.getTime()).toBe(created.createdAt.getTime())
  })

  it('softDeleteClient hides the client from get/list', async () => {
    const created = await createClient(userS, { firstName: 'Gone', lastName: 'G' })
    expect(await softDeleteClient(userS, created.id)).toBe(true)
    expect(await getClient(userS, created.id)).toBeNull()
    expect((await listClients(userS)).map((r) => r.id)).not.toContain(created.id)
  })

  it('softDeleteClient is not idempotent-true: a second call returns false', async () => {
    const created = await createClient(userS, { firstName: 'Twice', lastName: 'T' })
    expect(await softDeleteClient(userS, created.id)).toBe(true)
    expect(await softDeleteClient(userS, created.id)).toBe(false)
  })

  it('updateClient returns null for a soft-deleted client', async () => {
    const created = await createClient(userS, { firstName: 'Dead', lastName: 'D' })
    expect(await softDeleteClient(userS, created.id)).toBe(true)
    expect(await updateClient(userS, created.id, { goals: 'nope' })).toBeNull()
  })

  it('updateClient cannot resurrect a soft-deleted client via a deletedAt patch', async () => {
    const created = await createClient(userS, { firstName: 'Erased', lastName: 'E' })
    expect(await softDeleteClient(userS, created.id)).toBe(true)

    await updateClient(userS, created.id, { deletedAt: null } as never)
    expect(await getClient(userS, created.id)).toBeNull()

    // Locks the isNull(deletedAt) predicate, NOT the whitelist: the row is
    // already out of the UPDATE's scope, so the patch matches zero rows either
    // way. The whitelist is what the next test proves.
    const [raw] = await db.select().from(clients).where(eq(clients.id, created.id))
    expect(raw.deletedAt).not.toBeNull()
  })

  it('updateClient drops non-whitelisted keys on a LIVE client', async () => {
    const created = await createClient(userS, { firstName: 'Live', lastName: 'L' })
    const forgedCreatedAt = new Date('2000-01-01T00:00:00Z')

    // The real mass-assignment surface. Without the service whitelist, a parsed
    // JSON body could soft-delete a client without going through
    // softDeleteClient (bypassing Task 3's audit hook), rewrite the GDPR lawful
    // basis, or backdate created_at.
    const patched = await updateClient(userS, created.id, {
      goals: 'legit',
      deletedAt: new Date(),
      lawfulBasis: 'art_6_1_a_consent',
      createdAt: forgedCreatedAt,
    } as never)

    expect(patched?.goals).toBe('legit') // whitelisted key still applies
    expect(patched?.deletedAt).toBeNull()
    expect(patched?.lawfulBasis).toBe('art_9_2_h_healthcare')
    expect(patched?.createdAt.getTime()).toBe(created.createdAt.getTime())
    // Still reachable — the smuggled deletedAt did not land.
    expect((await getClient(userS, created.id))?.id).toBe(created.id)
  })

  it('createClient cannot override tenantId or lawfulBasis', async () => {
    const c = await createClient(userS, {
      firstName: 'Injected',
      lastName: 'I',
      tenantId: tenantIdOther,
      lawfulBasis: 'art_6_1_a_consent',
      id: '00000000-0000-0000-0000-000000000001',
    } as never)
    expect(c.tenantId).toBe(tenantIdS)
    expect(c.lawfulBasis).toBe('art_9_2_h_healthcare')
    expect(c.id).not.toBe('00000000-0000-0000-0000-000000000001')
  })

  it('another tenant cannot read, list, update or soft-delete this tenant client', async () => {
    const mine = await createClient(userS, { firstName: 'Mine', lastName: 'M', goals: 'keep' })
    const theirs = await createClient(userOther, { firstName: 'Theirs', lastName: 'O' })
    expect(theirs.tenantId).toBe(tenantIdOther) // proves userOther has a working membership

    expect(await getClient(userOther, mine.id)).toBeNull()

    const otherIds = (await listClients(userOther)).map((r) => r.id)
    expect(otherIds).toContain(theirs.id)
    expect(otherIds).not.toContain(mine.id)

    // RLS filters the row out of the UPDATE, so zero rows come back — no throw.
    expect(await updateClient(userOther, mine.id, { goals: 'x' })).toBeNull()
    expect(await softDeleteClient(userOther, mine.id)).toBe(false)

    // Prove the failed update/delete did not land.
    const still = await getClient(userS, mine.id)
    expect(still?.id).toBe(mine.id)
    expect(still?.goals).toBe('keep')
    expect(still?.deletedAt).toBeNull()
  })
})
