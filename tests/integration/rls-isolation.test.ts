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
})
