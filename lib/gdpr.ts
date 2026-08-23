import { and, eq } from 'drizzle-orm'
import { authedDb, withUser } from '@/db/authed-client'
import { db } from '@/db/client'
import { auditLog, clientConsents, clients, tenantMembers } from '@/db/schema'
import { recordAudit } from '@/lib/audit'

export type ClientExport = {
  client: typeof clients.$inferSelect
  consents: (typeof clientConsents.$inferSelect)[]
  auditLog: (typeof auditLog.$inferSelect)[]
}

/**
 * The client, if the caller can reach it under RLS — **including a soft-deleted
 * one**.
 *
 * DELIBERATE departure from `lib/clients.ts` / `lib/consents.ts`, both of which
 * filter `isNull(deletedAt)`. Do not "fix" it: a soft-deleted client's data is
 * still on disk, and a soft delete is exactly what precedes an erasure request.
 * Hiding it here would make the data unexportable and unerasable — the client
 * would be able to neither see nor remove what we still hold.
 *
 * Takes the live `tx`: a nested `withUser()` would open a second pooled
 * connection with no `app.user_id` GUC and silently see zero rows.
 */
async function reachableClient(
  tx: typeof authedDb,
  clientId: string,
): Promise<typeof clients.$inferSelect | null> {
  const [row] = await tx.select().from(clients).where(eq(clients.id, clientId)).limit(1)
  return row ?? null
}

/**
 * The caller's OWN membership tenant, from `tenant_members` under RLS. Throws
 * when the caller has none — fail-closed.
 *
 * This, not `clients.tenant_id`, is what scopes the owner-path UPDATE below. The
 * clients policy makes the two equal today, but the membership row is the value
 * the caller cannot influence at all, so the BYPASSRLS statement's blast radius
 * stays bounded by the caller's own tenant no matter what the clients policy is
 * later loosened to admit. It is only ever read AFTER a client has been found,
 * so a visible client implies a membership and the throw cannot fire in
 * practice — and if it ever does, it fires loudly BEFORE anything is destroyed
 * rather than handing `null` to a `tenant_id = NULL` predicate that matches
 * nothing and silently skips anonymization.
 */
async function callerTenantId(tx: typeof authedDb): Promise<string> {
  const [m] = await tx.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).limit(1)
  if (!m) throw new Error('no tenant for user')
  return m.tenantId
}

/** Membership under RLS, or null when the caller has none. */
async function callerTenantIdOrNull(tx: typeof authedDb): Promise<string | null> {
  const [m] = await tx.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).limit(1)
  return m?.tenantId ?? null
}

/**
 * Logs a denied GDPR access attempt, attributed to the CALLER's tenant.
 *
 * The attempted id is deliberately NOT recorded: it may belong to another
 * tenant, and this tenant's audit log would then permanently hold a foreign
 * client identifier that tenant-scoped erasure can never reach (owner decision,
 * 2026-08-23 — carried over from `lib/clients.ts`).
 *
 * A caller with no membership cannot be logged on the request path at all — the
 * policy's WITH CHECK has no tenant to match — so that case is silently skipped
 * rather than turned into an exception. Throwing there was the regression that
 * had to be reverted from `listClients`.
 */
async function recordDeny(tx: typeof authedDb): Promise<void> {
  const tenantId = await callerTenantIdOrNull(tx)
  if (!tenantId) return
  await recordAudit(tx, {
    action: 'deny',
    entity: 'client',
    entityId: null,
    clientId: null,
    metadata: { outcome: 'denied' },
    tenantId,
  })
}

/**
 * Art 15 / Art 20: every row we hold that references this client.
 *
 * Consents and audit rows are read DIRECTLY here, not through
 * `lib/consents.ts`: `activeConsents` filters soft-deleted clients out and
 * would return `[]` plus a spurious deny row for exactly the clients most
 * likely to be exported. It also returns only ACTIVE scopes, whereas an export
 * owes the client the full consent history including withdrawals.
 *
 * NOT included by construction: list-view rows and `deny` rows, which carry
 * `client_id = null` by design and are therefore invisible to a client-scoped
 * query. That is correct — neither identifies this client — but it means "every
 * audit row about this data subject" is narrower than "every audit row the
 * tenant holds".
 */
export function exportClient(userId: string, clientId: string): Promise<ClientExport | null> {
  return withUser(userId, async (tx) => {
    const client = await reachableClient(tx, clientId)
    if (!client) {
      await recordDeny(tx)
      return null
    }

    const consents = await tx
      .select()
      .from(clientConsents)
      .where(eq(clientConsents.clientId, client.id))
    const audit = await tx.select().from(auditLog).where(eq(auditLog.clientId, client.id))

    // Written after the reads, so the export row is not part of its own dump.
    // Unlike the erase row this one legitimately references a client that still
    // exists. Counts only — the denylist forbids anything client-identifying.
    await recordAudit(tx, {
      action: 'export',
      entity: 'client',
      entityId: client.id,
      clientId: client.id,
      metadata: { consents: consents.length, auditRows: audit.length },
      tenantId: client.tenantId,
    })
    return { client, consents, auditLog: audit }
  })
}

/**
 * Art 17: erase one client under the per-table policy —
 * `clients` and `client_consents` hard-deleted, `audit_log` ANONYMIZED and
 * retained (the audit trail is itself a legal obligation).
 *
 * ORDER IS LOAD-BEARING, and it is deliberately NOT the plan's order:
 *
 *  1. verify reachability on the request path (RLS is the ownership proof);
 *  2. anonymize `audit_log` through the owner connection;
 *  3. delete the clinical rows on the request path, then write the erase row.
 *
 * The plan deleted first and anonymized second, which cannot satisfy spec §9
 * ("on failure, surface and do not mark the client erased"): once the clinical
 * delete has committed, the client IS erased and a later anonymization failure
 * can no longer be un-marked. With this order a crash between steps 2 and 3
 * leaves the client PRESENT and the whole operation RETRYABLE — step 2 is
 * idempotent by construction (it nulls columns that are already null) and step 3
 * completes on the retry. The cost is the mirror image: a permanently-failing
 * erasure loses audit DETAIL (`entity_id`, `metadata`) for a client that still
 * exists, while retaining the row, action, `at`, actor and tenant. Losing
 * detail on a live client is recoverable; a client marked erased with clinical
 * rows still on disk is not.
 *
 * Steps 1 and 3 are two SEQUENTIAL top-level `withUser` calls — never nested
 * (see the warning in `db/authed-client.ts`). Do not merge them for atomicity:
 * the owner-path UPDATE has to land BETWEEN them, and there is nowhere else to
 * put it. Inside a request transaction it would be a second connection with no
 * `app.user_id` GUC; after the merged transaction it would be the plan's broken
 * order again. Two transactions with an idempotent middle step is the trade.
 *
 * Returns false when the client is not reachable (unknown, or another tenant's)
 * — the deny row is written in the same transaction, so a throw would roll it
 * back. Any actual FAILURE throws: never report a partial erasure as success.
 *
 * POLICY SLOT (spec §5, unresolved): invoice / other tax-retained tables. Greek
 * tax law requires retention that Art 17 cannot override, so those rows are
 * neither deleted nor anonymized here. The open question is which columns of a
 * retained invoice may stay identifying and for how long — it is answered by the
 * myDATA retention spike, and the billing module wires it in. Do not invent a
 * rule here; there is no such table yet.
 */
export async function eraseClient(userId: string, clientId: string): Promise<boolean> {
  // --- Step 1: ownership proof on the request path. ------------------------
  const target = await withUser(userId, async (tx) => {
    const client = await reachableClient(tx, clientId)
    if (!client) {
      await recordDeny(tx)
      return null
    }
    // Only after a client was found — see callerTenantId's note.
    return { id: client.id, tenantId: await callerTenantId(tx) }
  })
  if (!target) return false

  // --- Step 2: anonymize the audit trail on the OWNER connection. ----------
  // The request role has no UPDATE grant on audit_log (Task 3's REVOKE is the
  // whole point), so this is the single sanctioned request-path owner write.
  //
  // The owner connection has BYPASSRLS: this statement carries its own guards
  // or it has none. `client_id` alone is a globally unique uuid, which is why
  // the plan thought it sufficed — but audit_log has no FK on client_id and its
  // WITH CHECK validates only tenant_id, so another tenant CAN hold a row
  // referencing this client, and a client_id-only WHERE would silently rewrite
  // it. tenant_id bounds the blast radius to the caller's own tenant.
  await db
    .update(auditLog)
    .set({ clientId: null, entityId: null, metadata: null })
    .where(and(eq(auditLog.clientId, target.id), eq(auditLog.tenantId, target.tenantId)))

  // --- Step 3: destroy the clinical rows, then record the erasure. ---------
  return withUser(userId, async (tx) => {
    // Explicit, though `client_consents.client_id` cascades: the per-table
    // policy is stated in code, not left to a constraint.
    await tx.delete(clientConsents).where(eq(clientConsents.clientId, target.id))
    const deleted = await tx
      .delete(clients)
      .where(eq(clients.id, target.id))
      .returning({ id: clients.id })
    if (deleted.length === 0) {
      // The client was reachable in step 1 and is gone now: a concurrent
      // erasure of the same client raced us. Surface it — the caller must not
      // be told an erasure it did not perform succeeded, and step 2 has already
      // anonymized this client's audit detail.
      throw new Error('erasure raced: client disappeared after the reachability check')
    }

    // No client reference: spec §5 ("no client PII"), and with this ordering the
    // erase row is written AFTER anonymization, so a populated client_id would
    // be a fresh dangling pointer to the row just deleted.
    //
    // DEVIATION from spec §5's "actor=system": the real actor from the
    // app.user_id GUC is kept. The acting user is the controller's staff, not
    // the data subject — erasure does not cover them — and knowing who ran an
    // irreversible deletion is worth more than the pseudonym.
    await recordAudit(tx, {
      action: 'erase',
      entity: 'client',
      entityId: null,
      clientId: null,
      tenantId: target.tenantId,
    })
    return true
  })
}
