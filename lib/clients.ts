import { and, eq, isNull, sql } from 'drizzle-orm'
import { authedDb, withUser } from '@/db/authed-client'
import { clients, tenantMembers } from '@/db/schema'
import { recordAudit } from '@/lib/audit'

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

// Runtime whitelist of caller-writable columns. Everything not listed here is
// dropped before it reaches the DB, so a request body cannot reach id,
// tenantId, createdAt, lawfulBasis (a legal fact, not user input) or deletedAt
// — a `{ deletedAt: null }` patch would otherwise resurrect an erased client.
// `satisfies` rejects a typo or a key that isn't on NewClient.
const NEW_CLIENT_KEYS = [
  'firstName',
  'lastName',
  'dob',
  'sex',
  'email',
  'phone',
  'address',
  'afm',
  'medicalHistory',
  'allergies',
  'goals',
  'notes',
] as const satisfies readonly (keyof NewClient)[]

// The other direction: adding a field to NewClient without listing it above
// makes this alias resolve to `false`, which fails the `extends true` bound.
type Assert<T extends true> = T
export type NewClientKeysAreComplete = Assert<
  Exclude<keyof NewClient, (typeof NEW_CLIENT_KEYS)[number]> extends never ? true : false
>

/** Keep only whitelisted keys. Validation also belongs at the route layer, but
 *  this service is reachable from route handlers, server actions and the Task 5
 *  GDPR paths — a route-only guard is bypassed by any of them. */
function pickClientFields(input: Partial<NewClient>): Partial<NewClient> {
  const src = input as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of NEW_CLIENT_KEYS) {
    if (src[key] !== undefined) out[key] = src[key]
  }
  return out as Partial<NewClient>
}

// All mutation timestamps come from the DB clock (`now()` = transaction start),
// the same source as the columns' defaultNow(). Using the app clock here let a
// skewed function host persist updated_at < created_at.
const dbNow = sql`now()`

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
      .values({
        ...pickClientFields(input),
        // Restated because the whitelist returns a Partial and these are NOT NULL.
        firstName: input.firstName,
        lastName: input.lastName,
        tenantId,
      })
      .returning()
    // Same tx as the insert: if the audit write fails the client insert rolls
    // back, so no client can be created unaudited. tenantId is passed through
    // to save a second identical membership round trip.
    await recordAudit(tx, {
      action: 'create',
      entity: 'client',
      entityId: row.id,
      clientId: row.id,
      tenantId,
    })
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
    // Only audit a read that actually returned a record. A miss (unknown id or
    // another tenant's client, filtered out by RLS) leaves no trace — see the
    // note in the Task 3 report about logging denied attempts.
    if (row) {
      await recordAudit(tx, {
        action: 'view',
        entity: 'client',
        entityId: row.id,
        clientId: row.id,
      })
    }
    return row ?? null
  })
}

export function listClients(userId: string): Promise<Client[]> {
  return withUser(userId, async (tx) => {
    // No membership → RLS exposes no client rows, so no access happened and
    // there is nothing to log. Matches getClient/updateClient/softDeleteClient,
    // which likewise skip the audit row when nothing was reachable.
    const [membership] = await tx
      .select({ tenantId: tenantMembers.tenantId })
      .from(tenantMembers)
      .limit(1)
    if (!membership) return []

    const rows = await tx.select().from(clients).where(isNull(clients.deletedAt))
    // Spec §5: a list view is ONE audit row with entity_id (and client_id) null,
    // not one per row.
    await recordAudit(tx, {
      action: 'view',
      entity: 'client',
      entityId: null,
      clientId: null,
      metadata: { count: rows.length },
      tenantId: membership.tenantId,
    })
    return rows
  })
}

export function updateClient(
  userId: string,
  clientId: string,
  patch: Partial<NewClient>,
): Promise<Client | null> {
  return withUser(userId, async (tx) => {
    const [row] = await tx
      .update(clients)
      .set({ ...pickClientFields(patch), updatedAt: dbNow })
      .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
      .returning()
    if (row) {
      await recordAudit(tx, {
        action: 'update',
        entity: 'client',
        entityId: row.id,
        clientId: row.id,
      })
    }
    return row ?? null
  })
}

export function softDeleteClient(userId: string, clientId: string): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .update(clients)
      // A soft-delete is a mutation: bump updatedAt too, or it goes stale and
      // Task 5's erasure logic reads a timestamp that predates the deletion.
      .set({ deletedAt: dbNow, updatedAt: dbNow })
      .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
      .returning({ id: clients.id })
    // Guarded on a row having changed: a second call matches nothing, so it must
    // not append a second delete row.
    if (rows.length > 0) {
      await recordAudit(tx, {
        action: 'delete',
        entity: 'client',
        entityId: rows[0].id,
        clientId: rows[0].id,
      })
    }
    return rows.length > 0
  })
}
