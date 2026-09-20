import { and, eq, isNull, sql } from 'drizzle-orm'
import { withUser } from '@/db/authed-client'
import { clientConsents } from '@/db/schema'
import { reachableClient, recordDeny } from '@/lib/client-access'
import { recordAudit } from '@/lib/audit'

// Defined in db/ so db/schema.ts can build the CHECK from the same list without
// importing this module (which would be a cycle via db/authed-client).
// Re-exported because this has always been the import site for callers; imported
// as well because `export … from` creates no local binding and the body uses both.
import { CONSENT_SCOPES, type ConsentScope } from '@/db/consent-scopes'
export { CONSENT_SCOPES, type ConsentScope, type ConsentScopesAreComplete } from '@/db/consent-scopes'

/**
 * `scope` arrives here as a parameter — a value out of `JSON.parse` in a route
 * handler or server action has bypassed the TypeScript union entirely. Reject it
 * before touching the DB (same defect class as Task 2's mass assignment, guarded
 * the same way).
 *
 * `client_consents_scope_known` now backstops this in the database, so a gap here
 * is a 23514 rather than a silently unreadable row. Keep both: this one fails
 * with a legible message and without opening a transaction, and it is the only
 * guard on any future path that reaches the column outside this module.
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

/** The active row(s) for one client and scope — the predicate both the update
 *  statements and the partial unique index are built on. */
function activeScope(clientId: string, scope: ConsentScope) {
  return and(
    eq(clientConsents.clientId, clientId),
    eq(clientConsents.scope, scope),
    isNull(clientConsents.withdrawnAt),
  )
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
    // FOR UPDATE: the supersede below is withdraw-then-insert, so two concurrent
    // grants of one (client_id, scope) can both see zero active rows, both
    // insert, and the loser trips client_consents_one_active_per_scope — a 500
    // for a double-click. Locking the parent client row serialises the critical
    // section. The FK's own FOR KEY SHARE lock does not: two KEY SHARE holders
    // are compatible with each other.
    const client = await reachableClient(tx, clientId, { lock: true })
    if (!client) {
      await recordDeny(tx, 'consent')
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
      await recordDeny(tx, 'consent')
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
 * Scopes are still filtered through CONSENT_SCOPES even though migration 0007
 * added `client_consents_scope_known`. The CHECK stops NEW out-of-band values;
 * it says nothing about rows written before it existed, nor about a scope
 * RETIRED from the union while its CHECK literal remains. This filter is what
 * keeps such a row out of the typed result.
 */
export function activeConsents(userId: string, clientId: string): Promise<ConsentScope[]> {
  return withUser(userId, async (tx) => {
    const client = await reachableClient(tx, clientId)
    if (!client) {
      await recordDeny(tx, 'consent')
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
