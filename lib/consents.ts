import { and, eq, isNull, sql } from 'drizzle-orm'
import { authedDb, withUser } from '@/db/authed-client'
import { clientConsents, clients, tenantMembers } from '@/db/schema'
import { recordAudit } from '@/lib/audit'

export type ConsentScope = 'email_comms' | 'marketing' | 'third_party_sharing' | 'portal_access'

/** The closed set of scopes, and the order `activeConsents` returns them in. */
export const CONSENT_SCOPES = [
  'email_comms',
  'marketing',
  'third_party_sharing',
  'portal_access',
] as const satisfies readonly ConsentScope[]

// The other direction: adding a member to ConsentScope without listing it above
// makes this alias resolve to `false`, which fails the `extends true` bound.
type Assert<T extends true> = T
export type ConsentScopesAreComplete = Assert<
  Exclude<ConsentScope, (typeof CONSENT_SCOPES)[number]> extends never ? true : false
>

/**
 * `scope` is `text` in the DB with no CHECK constraint, and it arrives here as a
 * parameter — a value out of `JSON.parse` in a route handler or server action has
 * bypassed the TypeScript union entirely. Reject it before touching the DB, or
 * the table accumulates scopes nothing can read back (same defect class as Task
 * 2's mass assignment, guarded the same way).
 *
 * The two guarded entry points are `async` so this surfaces as a REJECTED
 * promise: a synchronous throw out of a Promise-returning function slips past a
 * caller's `.catch()`. Being outside `withUser` also means no transaction is
 * ever opened for a bad scope.
 */
function assertScope(scope: ConsentScope): void {
  if (!(CONSENT_SCOPES as readonly string[]).includes(scope)) {
    throw new Error(`unknown consent scope "${scope}"`)
  }
}

// All mutation timestamps come from the DB clock (`now()` = transaction start),
// the same source as granted_at's defaultNow(). The app clock would let a skewed
// function host persist withdrawn_at < granted_at.
const dbNow = sql`now()`

type Consent = typeof clientConsents.$inferSelect

/**
 * The client, if the caller can reach it under RLS. Returns its `tenant_id`
 * too: the policy's USING clause only admits rows whose tenant_id equals the
 * caller's membership tenant, so a visible row's tenant_id *is* the caller's —
 * one round trip instead of a second membership lookup. Even if the policy were
 * later loosened, the insert's WITH CHECK still rejects a mismatch.
 *
 * This lookup is the fix for the plan's cross-tenant hole: the FK to clients.id
 * is satisfied by ANY existing client and the WITH CHECK only validates
 * tenant_id (the caller's own), so without it a caller can attach a consent row
 * in their own tenant that references another tenant's client — a foreign
 * identifier the victim can neither see nor erase.
 *
 * Takes the live `tx`: a nested withUser() would open a second pooled connection
 * with no app.user_id GUC and silently see zero rows.
 */
async function reachableClient(
  tx: typeof authedDb,
  clientId: string,
): Promise<{ id: string; tenantId: string } | null> {
  const [row] = await tx
    .select({ id: clients.id, tenantId: clients.tenantId })
    .from(clients)
    .where(and(eq(clients.id, clientId), isNull(clients.deletedAt)))
    .limit(1)
  return row ?? null
}

/** The active row(s) for one client and scope — the predicate both the update
 *  statements and the partial unique index are built on. */
function activeScope(clientId: string, scope: ConsentScope) {
  return and(
    eq(clientConsents.clientId, clientId),
    eq(clientConsents.scope, scope),
    isNull(clientConsents.withdrawnAt),
  )
}

/** Membership under RLS, or null when the caller has none. */
async function callerTenantIdOrNull(tx: typeof authedDb): Promise<string | null> {
  const [m] = await tx.select({ tenantId: tenantMembers.tenantId }).from(tenantMembers).limit(1)
  return m?.tenantId ?? null
}

/**
 * Logs a denied per-client consent attempt, attributed to the CALLER's tenant.
 *
 * The attempted id is deliberately NOT recorded: it may belong to another tenant,
 * and this tenant's audit log would then permanently hold a foreign client
 * identifier that Task 5's tenant-scoped erasure can never reach (owner
 * decision, 2026-08-23 — carried over from lib/clients.ts).
 *
 * A caller with no membership cannot be logged on the request path at all — the
 * policy's WITH CHECK has no tenant to match — so that case is silently skipped
 * rather than turned into an exception. Throwing there was the regression that
 * had to be reverted from listClients.
 */
async function recordDeny(tx: typeof authedDb): Promise<void> {
  const tenantId = await callerTenantIdOrNull(tx)
  if (!tenantId) return
  await recordAudit(tx, {
    action: 'deny',
    entity: 'consent',
    entityId: null,
    clientId: null,
    metadata: { outcome: 'denied' },
    tenantId,
  })
}

/**
 * Record a consent grant. Returns null when the client is not reachable for this
 * caller (unknown, soft-deleted, or another tenant's) — null rather than a throw
 * because the deny audit row is written in the same transaction, and a throw
 * would roll it back.
 *
 * SUPERSEDE (owner decision, 2026-08-23): re-granting a scope that is already
 * active withdraws the live row(s) first, in this same transaction, and inserts
 * the new one. `client_consents_one_active_per_scope` allows at most one active
 * row per (client_id, scope), so something has to give; superseding is the only
 * option that keeps the new `text_version` on the record, and re-consenting to
 * updated wording is exactly the event GDPR wants recorded. Returning the
 * existing row would silently discard it; raising a unique violation would push
 * withdraw-then-grant onto every caller.
 */
export async function grantConsent(
  userId: string,
  clientId: string,
  scope: ConsentScope,
  textVersion: string,
): Promise<Consent | null> {
  assertScope(scope)
  return withUser(userId, async (tx) => {
    const client = await reachableClient(tx, clientId)
    if (!client) {
      await recordDeny(tx)
      return null
    }

    // Before the insert, or it trips the partial unique index.
    const superseded = await tx
      .update(clientConsents)
      .set({ withdrawnAt: dbNow })
      .where(activeScope(client.id, scope))
      .returning({ id: clientConsents.id })

    const [row] = await tx
      .insert(clientConsents)
      .values({ tenantId: client.tenantId, clientId: client.id, scope, textVersion })
      .returning()

    // Same tx as the insert: a failed audit write rolls the grant back, so no
    // consent can be recorded unaudited. A supersede is ONE logical event, so it
    // carries a flag on the create row rather than a separate withdraw row.
    await recordAudit(tx, {
      action: 'create',
      entity: 'consent',
      entityId: row.id,
      clientId: client.id,
      metadata: superseded.length > 0 ? { scope, superseded: true } : { scope },
      tenantId: client.tenantId,
    })
    return row
  })
}

/**
 * Withdraw a scope. Sets `withdrawn_at` on EVERY active row for
 * (client_id, scope), not just the latest: withdrawal has to be total, or an
 * out-of-band double-active row stays active forever and Task 5's export reports
 * a live consent the client already withdrew. With the partial unique index in
 * place at most one row can be active, so this is belt-and-braces — and it is
 * what makes any pre-index data recoverable.
 *
 * Returns true when at least one row changed.
 */
export async function withdrawConsent(
  userId: string,
  clientId: string,
  scope: ConsentScope,
): Promise<boolean> {
  assertScope(scope)
  return withUser(userId, async (tx) => {
    const client = await reachableClient(tx, clientId)
    if (!client) {
      await recordDeny(tx)
      return false
    }

    const withdrawn = await tx
      .update(clientConsents)
      .set({ withdrawnAt: dbNow })
      .where(activeScope(client.id, scope))
      .returning({ id: clientConsents.id })

    // One audit row per consent row that actually changed state; nothing at all
    // when the scope was already inactive.
    for (const row of withdrawn) {
      await recordAudit(tx, {
        action: 'update',
        entity: 'consent',
        entityId: row.id,
        clientId: client.id,
        metadata: { scope, withdrawn: true },
        tenantId: client.tenantId,
      })
    }
    return withdrawn.length > 0
  })
}

/**
 * The scopes currently consented to, in CONSENT_SCOPES order.
 *
 * ONE query, and deliberately no ORDER BY: it asks which distinct scopes have an
 * active row, not which row is newest. The plan ran a query per scope and picked
 * `order by granted_at desc limit 1`, which is a coin flip when two rows share
 * granted_at (both come from the same `now()`). Since withdrawal is total,
 * "has an active row" is equivalent to "the latest row is active" — an active
 * row can only have been granted after the last withdrawal — so tie-breaking
 * is not merely deterministic here, it is structurally absent.
 *
 * Scopes are filtered through CONSENT_SCOPES: the column has no CHECK, so a
 * value written out of band must not leak into the typed result.
 */
export function activeConsents(userId: string, clientId: string): Promise<ConsentScope[]> {
  return withUser(userId, async (tx) => {
    const client = await reachableClient(tx, clientId)
    if (!client) {
      await recordDeny(tx)
      return []
    }

    const rows = await tx
      .selectDistinct({ scope: clientConsents.scope })
      .from(clientConsents)
      .where(and(eq(clientConsents.clientId, client.id), isNull(clientConsents.withdrawnAt)))
    const found = new Set(rows.map((r) => r.scope))
    const active = CONSENT_SCOPES.filter((scope) => found.has(scope))

    // Reading a client's consents is access to client data (spec §5).
    await recordAudit(tx, {
      action: 'view',
      entity: 'consent',
      entityId: null,
      clientId: client.id,
      metadata: { count: active.length },
      tenantId: client.tenantId,
    })
    return active
  })
}
