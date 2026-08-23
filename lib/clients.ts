import { and, eq, isNull } from 'drizzle-orm'
import { authedDb, withUser } from '@/db/authed-client'
import { clients, tenantMembers } from '@/db/schema'

export type NewClient = {
  firstName: string
  lastName: string
  dob?: string
  sex?: string
  email?: string
  phone?: string
  address?: string
  afm?: string
  medicalHistory?: string
  allergies?: string[]
  goals?: string
  notes?: string
}

type Client = typeof clients.$inferSelect

// Reads the caller's tenant_id from tenant_members under RLS (returns only the
// caller's own row). Throws if the caller has no membership — fail-closed.
// Takes the live `tx`: calling withUser() here would open a second pooled
// connection without the app.user_id GUC and silently see zero rows.
async function callerTenantId(tx: typeof authedDb): Promise<string> {
  const [m] = await tx.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).limit(1)
  if (!m) throw new Error('no tenant for user')
  return m.tenantId
}

export function createClient(userId: string, input: NewClient): Promise<Client> {
  return withUser(userId, async (tx) => {
    const tenantId = await callerTenantId(tx)
    const [row] = await tx
      .insert(clients)
      .values({ ...input, tenantId })
      .returning()
    return row
  })
}

export function getClient(userId: string, clientId: string): Promise<Client | null> {
  return withUser(userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(clients)
      .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
      .limit(1)
    return row ?? null
  })
}

export function listClients(userId: string): Promise<Client[]> {
  return withUser(userId, (tx) => tx.select().from(clients).where(isNull(clients.deletedAt)))
}

export function updateClient(
  userId: string,
  clientId: string,
  patch: Partial<NewClient>,
): Promise<Client | null> {
  return withUser(userId, async (tx) => {
    const [row] = await tx
      .update(clients)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
      .returning()
    return row ?? null
  })
}

export function softDeleteClient(userId: string, clientId: string): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .update(clients)
      .set({ deletedAt: new Date() })
      .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
      .returning({ id: clients.id })
    return rows.length > 0
  })
}
