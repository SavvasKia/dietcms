import { sql } from 'drizzle-orm'
import type { authedDb } from '@/db/authed-client'
import { auditLog, tenantMembers } from '@/db/schema'
import { isDenied } from '@/lib/pii-denylist'

export type AuditAction =
  | 'view'
  | 'create'
  | 'update'
  | 'delete'
  | 'export'
  | 'erase'
  /** A per-client access attempt that RLS refused. Carries no entity_id or
   *  client_id — see recordDeny in lib/clients.ts for why. */
  | 'deny'

export type AuditArgs = {
  action: AuditAction
  entity: string
  entityId?: string | null
  clientId?: string | null
  metadata?: Record<string, unknown> | null
  /** Pre-resolved caller tenant, when the caller already looked it up in this
   *  same transaction (createClient does). Purely an optimisation: a forged
   *  value is still rejected by the policy's WITH CHECK. */
  tenantId?: string
}

/**
 * The ONLY writer of `audit_log`.
 *
 * Takes the LIVE transaction from an enclosing `withUser(...)` — never opens its
 * own. A nested `withUser` / `authedDb.transaction()` would take a fresh pooled
 * connection with no `app.user_id` GUC, so RLS would see an empty user: the
 * membership lookup below would return nothing and the insert would fail its
 * WITH CHECK. Sharing the tx also means a failed audit write aborts the
 * mutation it belongs to, so nothing can be committed unaudited.
 *
 * `metadata` keys are checked against the shared PII denylist (GDPR: the audit
 * trail is retained after erasure, so it must never hold client identifiers —
 * those belong in the `client_id` column).
 */
export async function recordAudit(tx: typeof authedDb, args: AuditArgs): Promise<void> {
  if (args.metadata) {
    for (const key of Object.keys(args.metadata)) {
      if (isDenied(key)) throw new Error(`audit metadata key "${key}" is PII-denylisted`)
    }
  }

  let tenantId = args.tenantId
  if (!tenantId) {
    // Under RLS this returns only the caller's own membership row. Doubles as a
    // fail-closed guard: no membership → no audit row → no mutation.
    const [m] = await tx.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).limit(1)
    if (!m) throw new Error('no tenant for user')
    tenantId = m.tenantId
  }

  await tx.insert(auditLog).values({
    tenantId,
    // The verified user is the GUC the enclosing withUser set — the same value
    // RLS is matching on, so the actor cannot disagree with the policy.
    actorUserId: sql`current_setting('app.user_id', true)`,
    action: args.action,
    entity: args.entity,
    entityId: args.entityId ?? null,
    clientId: args.clientId ?? null,
    metadata: args.metadata ?? null,
  })
}
