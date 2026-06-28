/**
 * RLS isolation integration test (Path B — app-set app.user_id GUC).
 *
 * Seeds via the OWNER client (db), which bypasses RLS.
 * All assertions run via withUser / authenticated_backend, where RLS applies.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { db } from '../../db/client'
import { withUser } from '../../db/authed-client'
import { tenants, tenantMembers, notes } from '../../db/schema'
import { eq, or } from 'drizzle-orm'
import { ensureTenantForUser } from '../../lib/tenant'

// Unique suffix per run to avoid cross-run collisions
const run = Date.now().toString(36)
const userA = `user-a-${run}`
const userB = `user-b-${run}`

let tenantIdA: string
let tenantIdB: string
let noteIdA: string

describe('RLS tenant isolation (Path B)', () => {
  // Seed two independent users + tenants via the owner connection (bypasses RLS)
  beforeAll(async () => {
    const [tA] = await db.insert(tenants).values({ name: `Tenant A ${run}` }).returning()
    const [tB] = await db.insert(tenants).values({ name: `Tenant B ${run}` }).returning()
    tenantIdA = tA.id
    tenantIdB = tB.id

    await db.insert(tenantMembers).values([
      { userId: userA, tenantId: tenantIdA, role: 'owner' },
      { userId: userB, tenantId: tenantIdB, role: 'owner' },
    ])
  })

  afterAll(async () => {
    // Delete in dependency order (notes → tenant_members → tenants)
    await db.delete(notes).where(
      or(eq(notes.tenantId, tenantIdA), eq(notes.tenantId, tenantIdB)),
    )
    await db.delete(tenantMembers).where(
      or(eq(tenantMembers.userId, userA), eq(tenantMembers.userId, userB)),
    )
    await db.delete(tenants).where(
      or(eq(tenants.id, tenantIdA), eq(tenants.id, tenantIdB)),
    )
  })

  it('1. userA can insert a note into their own tenant', async () => {
    const [row] = await withUser(userA, (tx) =>
      tx.insert(notes).values({ tenantId: tenantIdA, body: 'Hello from A' }).returning(),
    )
    expect(row.id).toBeTruthy()
    noteIdA = row.id
  })

  it('2. userA sees their own note', async () => {
    const rows = await withUser(userA, (tx) => tx.select().from(notes))
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(noteIdA)
  })

  it("3. userB does NOT see userA's note", async () => {
    const rows = await withUser(userB, (tx) => tx.select().from(notes))
    const ids = rows.map((r) => r.id)
    expect(ids).not.toContain(noteIdA)
  })

  it('4. Cross-tenant insert is rejected by WITH CHECK', async () => {
    await expect(
      withUser(userB, (tx) =>
        tx.insert(notes).values({ tenantId: tenantIdA, body: 'evil cross-tenant' }),
      ),
    ).rejects.toThrow()
  })

  it('5. Empty/unknown userId sees zero rows (fail-closed)', async () => {
    const rows = await withUser('', (tx) => tx.select().from(notes))
    expect(rows.length).toBe(0)
  })

  it('6. userB can insert and see their own note (positive control)', async () => {
    const [rowB] = await withUser(userB, (tx) =>
      tx.insert(notes).values({ tenantId: tenantIdB, body: 'Hello from B' }).returning(),
    )
    const rows = await withUser(userB, (tx) => tx.select().from(notes))
    expect(rows.map((r) => r.id)).toContain(rowB.id)
  })
})

describe('RLS tenant_members + tenants isolation (B1) + idempotent bootstrap (B2)', () => {
  const run2 = `${Date.now().toString(36)}-b`
  const userC = `user-c-${run2}`
  const userD = `user-d-${run2}`
  let tenantIdC: string
  let tenantIdD: string

  beforeAll(async () => {
    const [tC] = await db.insert(tenants).values({ name: `Tenant C ${run2}` }).returning()
    const [tD] = await db.insert(tenants).values({ name: `Tenant D ${run2}` }).returning()
    tenantIdC = tC.id
    tenantIdD = tD.id
    await db.insert(tenantMembers).values([
      { userId: userC, tenantId: tenantIdC, role: 'owner' },
      { userId: userD, tenantId: tenantIdD, role: 'owner' },
    ])
  })

  afterAll(async () => {
    await db.delete(tenantMembers).where(or(eq(tenantMembers.userId, userC), eq(tenantMembers.userId, userD)))
    await db.delete(tenants).where(or(eq(tenants.id, tenantIdC), eq(tenants.id, tenantIdD)))
  })

  it('7. userC sees only their own tenant_members row', async () => {
    const rows = await withUser(userC, (tx) => tx.select().from(tenantMembers))
    expect(rows.length).toBe(1)
    expect(rows[0].userId).toBe(userC)
  })

  it("8. userC does NOT see userD's tenant_members row", async () => {
    const rows = await withUser(userC, (tx) => tx.select().from(tenantMembers))
    const userIds = rows.map((r) => r.userId)
    expect(userIds).not.toContain(userD)
  })

  it('9. userC sees only their own tenant', async () => {
    const rows = await withUser(userC, (tx) => tx.select().from(tenants))
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(tenantIdC)
  })

  it("10. userC does NOT see userD's tenant", async () => {
    const rows = await withUser(userC, (tx) => tx.select().from(tenants))
    const ids = rows.map((r) => r.id)
    expect(ids).not.toContain(tenantIdD)
  })

  it('11. ensureTenantForUser is idempotent — double-call returns same tenantId', async () => {
    const run3 = `${Date.now().toString(36)}-idem`
    const userE = `user-e-${run3}`
    const id1 = await ensureTenantForUser(userE, `Tenant E ${run3}`)
    const id2 = await ensureTenantForUser(userE, `Tenant E ${run3} second`)
    expect(id1).toBe(id2)
    // cleanup
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, userE))
    await db.delete(tenants).where(eq(tenants.id, id1))
  })

  it('12. No duplicate membership after idempotent ensureTenantForUser', async () => {
    const run4 = `${Date.now().toString(36)}-nodup`
    const userF = `user-f-${run4}`
    await ensureTenantForUser(userF, `Tenant F ${run4}`)
    await ensureTenantForUser(userF, `Tenant F ${run4} again`)
    const rows = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, userF))
    expect(rows.length).toBe(1)
    // cleanup
    const tenantId = rows[0].tenantId
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, userF))
    await db.delete(tenants).where(eq(tenants.id, tenantId))
  })
})
