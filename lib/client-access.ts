import { and, eq, isNull } from 'drizzle-orm'
import type { authedDb } from '@/db/authed-client'
import { clients, tenantMembers } from '@/db/schema'
import { recordAudit } from '@/lib/audit'

/**
 * The guards every client-scoped service repeats: who is the caller, is the
 * target theirs, and how is a refusal logged.
 *
 * Extracted when lib/measurements.ts would have been the FOURTH copy. All of
 * these take the LIVE `tx` from an enclosing `withUser(...)` and never open
 * their own — a nested withUser takes a fresh pooled connection with no
 * app.user_id GUC, so RLS would see an empty user and silently return nothing.
 *
 * lib/gdpr.ts deliberately does NOT use this module, for two reasons that both
 * happen to point the same way: its reachableClient must find SOFT-DELETED
 * clients (a soft delete is exactly what precedes an erasure request), and the
 * coverage gate in scripts/check-gdpr-coverage.ts only follows helpers declared
 * within lib/gdpr.ts — moving its `clients` read out of that file would red the
 * gate against correct code.
 */

/**
 * The client, if the caller can reach it under RLS and it is not soft-deleted.
 * Returns its `tenant_id` too: the policy's USING clause only admits rows whose
 * tenant_id equals the caller's membership tenant, so a visible row's tenant_id
 * *is* the caller's — one round trip instead of a second membership lookup.
 *
 * This lookup is also what closes the cross-tenant hole a bare FK leaves: a FK
 * to clients.id is satisfied by ANY existing client, and a child table's WITH
 * CHECK only validates tenant_id (the caller's own), so without it a caller can
 * attach a row in their own tenant that references another tenant's client — a
 * foreign identifier the victim can neither see nor erase.
 *
 * `lock` takes FOR UPDATE on the client row and is OPT-IN: read paths must not
 * stall behind an in-flight write. See grantConsent for the one case that
 * needs it (and why the FK's own FOR KEY SHARE lock does not suffice).
 */
export async function reachableClient(
  tx: typeof authedDb,
  clientId: string,
  opts: { lock?: boolean } = {},
): Promise<{ id: string; tenantId: string } | null> {
  const q = tx
    .select({ id: clients.id, tenantId: clients.tenantId })
    .from(clients)
    .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
    .limit(1)
  const [row] = opts.lock ? await q.for('update') : await q
  return row ?? null
}

/** Membership under RLS, or null when the caller has none. */
export async function callerTenantIdOrNull(tx: typeof authedDb): Promise<string | null> {
  const [m] = await tx.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).limit(1)
  return m?.tenantId ?? null
}

/** Membership under RLS. Throws when the caller has none — fail-closed. */
export async function callerTenantId(tx: typeof authedDb): Promise<string> {
  const tenantId = await callerTenantIdOrNull(tx)
  if (!tenantId) throw new Error('no tenant for user')
  return tenantId
}

/**
 * Logs a denied per-client access attempt, attributed to the CALLER's tenant.
 *
 * The attempted id is deliberately NOT recorded: it may belong to another
 * tenant, and this tenant's audit log would then permanently hold a foreign
 * client identifier that tenant-scoped erasure can never reach (owner decision,
 * 2026-08-23). The trade is that we know a denied attempt happened and by whom,
 * but not which record was probed.
 *
 * `entity` names what was being reached for, so the audit trail distinguishes a
 * refused client read from a refused consent or measurement write.
 *
 * A caller with no membership cannot be logged on the request path at all — the
 * policy's WITH CHECK has no tenant to match — so that case is silently skipped
 * rather than turned into an exception. Throwing there was the regression that
 * had to be reverted from listClients.
 */
export async function recordDeny(tx: typeof authedDb, entity: string): Promise<void> {
  const tenantId = await callerTenantIdOrNull(tx)
  if (!tenantId) return
  await recordAudit(tx, {
    action: 'deny',
    entity,
    entityId: null,
    clientId: null,
    metadata: { outcome: 'denied' },
    tenantId,
  })
}
