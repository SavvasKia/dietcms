/** clients RLS isolation (Path B). Seeds via owner; asserts via withUser. */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { db } from '../../db/client'
import { withUser } from '../../db/authed-client'
import { tenants, tenantMembers, clients } from '../../db/schema'
import { eq, or } from 'drizzle-orm'

/** Drizzle wraps pg errors ("Failed query: …") and puts the real one in `.cause`.
 *  Flatten the chain so an assertion can match the actual Postgres message. */
async function errorChain(fn: () => Promise<unknown>): Promise<string> {
  const err = await fn().then(
    () => null,
    (e: unknown) => e,
  )
  expect(err, 'expected the query to reject').toBeTruthy()
  const messages: string[] = []
  let cur: unknown = err
  while (cur instanceof Error) {
    messages.push(cur.message)
    cur = cur.cause
  }
  return messages.join(' | ')
}

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
