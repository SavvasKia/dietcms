/**
 * client_consents: tenant-isolated, FORCEd, and — unlike audit_log — keeping the
 * full CRUD grant, because withdrawal is an UPDATE on the request path.
 *
 * Everything is seeded and reaped through the OWNER client (`db`, BYPASSRLS);
 * every request-path assertion goes through `withUser` / authenticated_backend,
 * where RLS applies.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { withUser } from '../../db/authed-client'
import { tenants, tenantMembers, clients, clientConsents, auditLog } from '../../db/schema'
import { errorChain } from '../helpers/error-chain'
import { createClient } from '../../lib/clients'
import {
  grantConsent,
  withdrawConsent,
  activeConsents,
  CONSENT_SCOPES,
  type ConsentScope,
} from '../../lib/consents'

type AuditRow = typeof auditLog.$inferSelect
type ConsentRow = typeof clientConsents.$inferSelect

/**
 * Reap everything one tenant seeded, in dependency order.
 *
 * `audit_log` FIRST and always: it carries no FK, so nothing cascades it, and
 * the request role has no DELETE grant — only this owner path can clear it.
 * Task 3 omitted it from one afterAll and orphaned 237 rows, which no
 * verification gate can see.
 */
async function reap(tenantId: string, userIds: string[]) {
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId))
  await db.delete(clientConsents).where(eq(clientConsents.tenantId, tenantId))
  await db.delete(clients).where(eq(clients.tenantId, tenantId))
  for (const userId of userIds) {
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, userId))
  }
  await db.delete(tenants).where(eq(tenants.id, tenantId))
}

async function seed(label: string, userIds: string[]): Promise<string> {
  const [t] = await db.insert(tenants).values({ name: label }).returning()
  await db
    .insert(tenantMembers)
    .values(userIds.map((userId) => ({ userId, tenantId: t.id, role: 'owner' })))
  return t.id
}

/** Consent rows for one client read via the OWNER, so RLS can never be the
 *  reason a row looks absent (or present). */
function rowsFor(clientId: string): Promise<ConsentRow[]> {
  return db.select().from(clientConsents).where(eq(clientConsents.clientId, clientId))
}

/** grantConsent returns null on a denied client; the happy paths want the row. */
async function granted(
  userId: string,
  clientId: string,
  scope: ConsentScope,
  textVersion: string,
): Promise<ConsentRow> {
  const row = await grantConsent(userId, clientId, scope, textVersion)
  expect(row, 'grantConsent returned null for a reachable client').not.toBeNull()
  return row as ConsentRow
}

// ---------------------------------------------------------------------------
// 1. The table's RLS + grant shape. The behavioural tests below would stay
//    green if FORCE were dropped (the owner is the only BYPASSRLS role in the
//    suite) or if the grant were narrowed and RLS filtered the row out first.
// ---------------------------------------------------------------------------
describe('client_consents privilege + RLS shape', () => {
  it('authenticated_backend keeps full CRUD (no REVOKE on this table)', async () => {
    const { rows } = await db.execute(sql`
      select privilege_type from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = 'client_consents'
        and grantee = 'authenticated_backend'`)
    const privs = rows.map((r) => String(r.privilege_type))
    expect(privs, 'no grants at all — default privileges missed the table').not.toHaveLength(0)
    // UPDATE is load-bearing: withdrawal sets withdrawn_at on the request path.
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(privs).toContain(priv)
    }
  })

  it('client_consents has RLS both enabled and FORCEd', async () => {
    // ::text so the assertion cannot be fooled by a driver returning 'f' as a
    // truthy string.
    const { rows } = await db.execute(sql`
      select relrowsecurity::text as enabled, relforcerowsecurity::text as forced
      from pg_class where oid = 'public.client_consents'::regclass`)
    expect(rows[0].enabled).toBe('true')
    expect(rows[0].forced).toBe('true')
  })

  it('client_consents carries its tenant-isolation policy', async () => {
    const { rows } = await db.execute(sql`
      select policyname from pg_policies
      where schemaname = 'public' and tablename = 'client_consents'`)
    expect(rows.map((r) => String(r.policyname))).toContain('client_consents_tenant_isolation')
  })

  it('carries the partial unique index, WHERE predicate included', async () => {
    const { rows } = await db.execute(sql`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'client_consents'`)
    const defs = new Map(rows.map((r) => [String(r.indexname), String(r.indexdef)]))
    const def = defs.get('client_consents_one_active_per_scope')
    expect(def, 'the one-active-per-scope index is missing').toBeTruthy()
    expect(def).toMatch(/unique index/i)
    expect(def).toMatch(/client_id/)
    expect(def).toMatch(/scope/)
    // Without the predicate the index forbids re-granting after withdrawal —
    // a worse bug than the double-active row it exists to prevent.
    expect(def, 'the index has no WHERE predicate').toMatch(/withdrawn_at is null/i)
  })

  it('client_id cascades from clients', async () => {
    const { rows } = await db.execute(sql`
      select rc.delete_rule
      from information_schema.referential_constraints rc
      join information_schema.table_constraints tc
        on tc.constraint_name = rc.constraint_name
       and tc.constraint_schema = rc.constraint_schema
      where tc.table_schema = 'public' and tc.table_name = 'client_consents'`)
    expect(rows.map((r) => String(r.delete_rule))).toContain('CASCADE')
  })
})

// ---------------------------------------------------------------------------
// 2. The grant → withdraw → re-grant state machine, and the audit rows spec §5
//    requires the consent-service to write.
// ---------------------------------------------------------------------------
describe('consent lifecycle + audit rows', () => {
  const run = `${Date.now().toString(36)}-life`
  const userA = `con-life-${run}`
  let tenantIdA: string

  beforeAll(async () => {
    tenantIdA = await seed(`CON LIFE ${run}`, [userA])
  })
  afterAll(() => reap(tenantIdA, [userA]))

  /** Consent-entity audit rows for one client, read back under RLS. Filtered on
   *  entity so createClient's own `client` rows cannot inflate a count. */
  function consentAudits(clientId: string): Promise<AuditRow[]> {
    return withUser(userA, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.clientId, clientId), eq(auditLog.entity, 'consent'))),
    )
  }

  it('grant makes the scope active and writes one create row', async () => {
    const c = await createClient(userA, { firstName: 'Sofia', lastName: 'M' })
    const row = await granted(userA, c.id, 'email_comms', 'v1-el')

    expect(row.tenantId).toBe(tenantIdA)
    expect(row.clientId).toBe(c.id)
    expect(row.scope).toBe('email_comms')
    expect(row.textVersion).toBe('v1-el')
    expect(row.grantedAt).toBeInstanceOf(Date)
    expect(row.withdrawnAt).toBeNull()

    expect(await activeConsents(userA, c.id)).toEqual(['email_comms'])

    const creates = (await consentAudits(c.id)).filter((r) => r.action === 'create')
    expect(creates).toHaveLength(1)
    expect(creates[0].entity).toBe('consent')
    expect(creates[0].entityId).toBe(row.id)
    expect(creates[0].clientId).toBe(c.id)
    expect(creates[0].tenantId).toBe(tenantIdA)
    expect(creates[0].actorUserId).toBe(userA)
    expect(creates[0].metadata).toEqual({ scope: 'email_comms' })
  })

  it('withdraw deactivates the scope, retains the row, and writes an update row', async () => {
    const c = await createClient(userA, { firstName: 'Withdrawn', lastName: 'W' })
    const g = await granted(userA, c.id, 'marketing', 'v1-el')

    expect(await withdrawConsent(userA, c.id, 'marketing')).toBe(true)
    expect(await activeConsents(userA, c.id)).toEqual([])

    // Spec §4: withdraw is never a hard delete — the row stays for the trail.
    const rows = await rowsFor(c.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(g.id)
    expect(rows[0].withdrawnAt).toBeInstanceOf(Date)
    // Both stamps come from the DB clock, so withdrawal cannot predate the grant.
    expect(rows[0].withdrawnAt!.getTime()).toBeGreaterThanOrEqual(rows[0].grantedAt.getTime())

    const updates = (await consentAudits(c.id)).filter((r) => r.action === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].entityId).toBe(g.id)
    expect(updates[0].clientId).toBe(c.id)
    expect(updates[0].metadata).toEqual({ scope: 'marketing', withdrawn: true })
  })

  it('a second withdraw of a reachable client is a no-op with no audit row', async () => {
    const c = await createClient(userA, { firstName: 'Twice', lastName: 'T' })
    await granted(userA, c.id, 'marketing', 'v1-el')
    expect(await withdrawConsent(userA, c.id, 'marketing')).toBe(true)
    expect(await withdrawConsent(userA, c.id, 'marketing')).toBe(false)
    expect((await consentAudits(c.id)).filter((r) => r.action === 'update')).toHaveLength(1)
  })

  it('withdrawing a scope that was never granted returns false', async () => {
    const c = await createClient(userA, { firstName: 'Never', lastName: 'N' })
    expect(await withdrawConsent(userA, c.id, 'portal_access')).toBe(false)
    expect(await rowsFor(c.id)).toHaveLength(0)
  })

  it('re-grant after withdrawal makes the scope active again', async () => {
    const c = await createClient(userA, { firstName: 'Regrant', lastName: 'R' })
    await granted(userA, c.id, 'email_comms', 'v1-el')
    expect(await withdrawConsent(userA, c.id, 'email_comms')).toBe(true)
    expect(await activeConsents(userA, c.id)).toEqual([])

    await granted(userA, c.id, 'email_comms', 'v2-el')
    expect(await activeConsents(userA, c.id)).toEqual(['email_comms'])
    // Two rows of history: one withdrawn, one active.
    const rows = await rowsFor(c.id)
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.withdrawnAt === null)).toHaveLength(1)
  })

  it('withdrawal is scope-local: other scopes stay active', async () => {
    const c = await createClient(userA, { firstName: 'Scoped', lastName: 'S' })
    await granted(userA, c.id, 'email_comms', 'v1-el')
    await granted(userA, c.id, 'marketing', 'v1-el')
    expect(await withdrawConsent(userA, c.id, 'marketing')).toBe(true)
    expect(await activeConsents(userA, c.id)).toEqual(['email_comms'])
  })

  it('one activeConsents call covers every scope, in a stable order', async () => {
    const c = await createClient(userA, { firstName: 'AllFour', lastName: 'A' })
    // Granted in reverse declaration order: the result order must come from the
    // service, not from insertion order or from granted_at.
    for (const scope of [...CONSENT_SCOPES].reverse()) {
      await granted(userA, c.id, scope, 'v1-el')
    }
    expect(await activeConsents(userA, c.id)).toEqual([...CONSENT_SCOPES])
  })

  it('activeConsents writes a view row with client_id set (req 6)', async () => {
    const c = await createClient(userA, { firstName: 'Viewed', lastName: 'V' })
    await granted(userA, c.id, 'portal_access', 'v1-el')
    // Granting does not read, so there is no view row yet — the single row below
    // is unambiguously the one activeConsents wrote.
    expect((await consentAudits(c.id)).filter((r) => r.action === 'view')).toHaveLength(0)

    expect(await activeConsents(userA, c.id)).toEqual(['portal_access'])

    const views = (await consentAudits(c.id)).filter((r) => r.action === 'view')
    expect(views).toHaveLength(1)
    expect(views[0].entity).toBe('consent')
    expect(views[0].clientId).toBe(c.id)
    expect(views[0].entityId).toBeNull() // a collection read, like listClients
    expect(views[0].actorUserId).toBe(userA)
    expect(views[0].tenantId).toBe(tenantIdA)
    expect(views[0].metadata).toEqual({ count: 1 })
  })

  // Defect 3: with `order by granted_at desc limit 1`, two rows sharing
  // granted_at (both from the same now()) make the answer coin-flip. Seeded
  // through the owner in ONE insert so the two stamps are byte-identical.
  it('ties on granted_at resolve deterministically to active', async () => {
    const c = await createClient(userA, { firstName: 'Tie', lastName: 'T' })
    await db.insert(clientConsents).values([
      {
        tenantId: tenantIdA,
        clientId: c.id,
        scope: 'third_party_sharing',
        textVersion: 'tie-withdrawn',
        grantedAt: sql`now()`,
        withdrawnAt: sql`now()`,
      },
      {
        tenantId: tenantIdA,
        clientId: c.id,
        scope: 'third_party_sharing',
        textVersion: 'tie-active',
        grantedAt: sql`now()`,
      },
    ])
    const rows = await rowsFor(c.id)
    expect(rows).toHaveLength(2)
    expect(rows[0].grantedAt.getTime()).toBe(rows[1].grantedAt.getTime())

    expect(await activeConsents(userA, c.id)).toEqual(['third_party_sharing'])
  })
})

// ---------------------------------------------------------------------------
// 3. DEFECT 1 — grantConsent must not attach a consent row to a client it
//    cannot see. The FK is satisfied by ANY existing client and the WITH CHECK
//    only validates tenant_id (the caller's own), so nothing in the DB stops a
//    caller from planting a foreign client_id in their own tenant.
// ---------------------------------------------------------------------------
describe('grantConsent refuses a client outside the caller tenant (defect 1)', () => {
  const run = `${Date.now().toString(36)}-xt`
  const userD = `con-xt-d-${run}` // attacker
  const userV = `con-xt-v-${run}` // victim, owns the client
  let tenantIdD: string
  let tenantIdV: string
  let victimClientId: string

  beforeAll(async () => {
    tenantIdD = await seed(`CON XT D ${run}`, [userD])
    tenantIdV = await seed(`CON XT V ${run}`, [userV])
    victimClientId = (await createClient(userV, { firstName: 'Victim', lastName: 'V' })).id
  })
  afterAll(async () => {
    await reap(tenantIdD, [userD])
    await reap(tenantIdV, [userV])
  })

  function denies(): Promise<AuditRow[]> {
    return withUser(userD, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'deny'), eq(auditLog.entity, 'consent'))),
    )
  }

  it('inserts nothing and writes a deny row in the caller tenant', async () => {
    expect(await denies()).toHaveLength(0)

    expect(await grantConsent(userD, victimClientId, 'marketing', 'v1-el')).toBeNull()

    // Owner view: no consent row anywhere references the victim's client.
    expect(
      await rowsFor(victimClientId),
      "a consent row was attached to another tenant's client",
    ).toHaveLength(0)

    const rows = await denies()
    expect(rows).toHaveLength(1)
    expect(rows[0].tenantId).toBe(tenantIdD) // the caller's tenant, not the victim's
    expect(rows[0].actorUserId).toBe(userD)
    expect(rows[0].entity).toBe('consent')
    // The probed uuid is deliberately NOT retained (Task 3 owner decision).
    expect(rows[0].entityId).toBeNull()
    expect(rows[0].clientId).toBeNull()
    expect(rows[0].metadata).toEqual({ outcome: 'denied' })
  })

  it('an unknown uuid is denied the same way', async () => {
    const before = (await denies()).length
    expect(await grantConsent(userD, crypto.randomUUID(), 'marketing', 'v1-el')).toBeNull()
    expect(await denies()).toHaveLength(before + 1)
  })

  it("a soft-deleted client is unreachable, so its consents cannot be granted", async () => {
    const c = await createClient(userD, { firstName: 'Soft', lastName: 'D' })
    await db.update(clients).set({ deletedAt: sql`now()` }).where(eq(clients.id, c.id))
    expect(await grantConsent(userD, c.id, 'marketing', 'v1-el')).toBeNull()
    expect(await rowsFor(c.id)).toHaveLength(0)
  })

  it('the deny row is not visible to the probed tenant', async () => {
    const victimRows = await withUser(userV, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'deny')),
    )
    expect(victimRows).toHaveLength(0)
  })

  it("the victim can still grant consent on their own client", async () => {
    const row = await granted(userV, victimClientId, 'marketing', 'v1-el')
    expect(row.tenantId).toBe(tenantIdV)
    expect(await activeConsents(userV, victimClientId)).toEqual(['marketing'])
  })
})

// ---------------------------------------------------------------------------
// 4. At most one ACTIVE row per (client_id, scope) — enforced by the partial
//    unique index, and made reachable by grantConsent's supersede step (owner
//    decision, 2026-08-23): a re-grant withdraws the live rows and records the
//    new text_version, because re-consenting to updated wording is itself the
//    event GDPR requires on the record.
//
//    DEFECT 2 (withdrawConsent must withdraw EVERY active row, not just the
//    latest) is kept as belt-and-braces: it is what keeps a pre-index or
//    out-of-band double-active row recoverable. See the report — with the index
//    in place no path can construct that state any more.
// ---------------------------------------------------------------------------
describe('one active row per scope: index + supersede (defect 2)', () => {
  const run = `${Date.now().toString(36)}-tot`
  const userT = `con-tot-${run}`
  let tenantIdT: string

  beforeAll(async () => {
    tenantIdT = await seed(`CON TOT ${run}`, [userT])
  })
  afterAll(() => reap(tenantIdT, [userT]))

  function consentAudits(clientId: string): Promise<AuditRow[]> {
    return withUser(userT, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.clientId, clientId), eq(auditLog.entity, 'consent'))),
    )
  }

  it('a re-grant supersedes the live row and records the new text_version', async () => {
    const c = await createClient(userT, { firstName: 'Supersede', lastName: 'S' })
    const first = await granted(userT, c.id, 'third_party_sharing', 'v1-el')
    const second = await granted(userT, c.id, 'third_party_sharing', 'v2-el')
    expect(second.id).not.toBe(first.id)

    const rows = await rowsFor(c.id)
    expect(rows).toHaveLength(2) // history preserved, not overwritten
    const active = rows.filter((r) => r.withdrawnAt === null)
    expect(active).toHaveLength(1)
    expect(active[0].id).toBe(second.id)
    expect(active[0].textVersion, 'the new consent wording was discarded').toBe('v2-el')

    const old = rows.find((r) => r.id === first.id)!
    expect(old.textVersion).toBe('v1-el')
    expect(old.withdrawnAt).toBeInstanceOf(Date)

    expect(await activeConsents(userT, c.id)).toEqual(['third_party_sharing'])
  })

  it('the supersede is audited as one create event, not create + update', async () => {
    const c = await createClient(userT, { firstName: 'Audited', lastName: 'A' })
    const first = await granted(userT, c.id, 'marketing', 'v1-el')
    const second = await granted(userT, c.id, 'marketing', 'v2-el')

    const audits = await consentAudits(c.id)
    const creates = audits.filter((r) => r.action === 'create')
    expect(creates).toHaveLength(2)
    // Matched by entity_id, not by position: the select has no ORDER BY.
    expect(creates.find((r) => r.entityId === first.id)!.metadata).toEqual({ scope: 'marketing' })
    const superseding = creates.find((r) => r.entityId === second.id)!
    expect(superseding.metadata).toEqual({ scope: 'marketing', superseded: true })
    // The supersede is one logical event: no separate withdraw row for the
    // row it replaced.
    expect(audits.filter((r) => r.action === 'update')).toHaveLength(0)
  })

  it('grant → withdraw → grant again succeeds (the index predicate)', async () => {
    // This is the test that fails if the index loses its WHERE clause.
    const c = await createClient(userT, { firstName: 'Cycle', lastName: 'C' })
    await granted(userT, c.id, 'portal_access', 'v1-el')
    expect(await withdrawConsent(userT, c.id, 'portal_access')).toBe(true)
    const again = await granted(userT, c.id, 'portal_access', 'v2-el')
    expect(again.withdrawnAt).toBeNull()
    expect(await activeConsents(userT, c.id)).toEqual(['portal_access'])
    expect(await rowsFor(c.id)).toHaveLength(2)
  })

  it('a second simultaneously-active row is rejected by the unique index', async () => {
    const c = await createClient(userT, { firstName: 'Dup', lastName: 'D' })
    await granted(userT, c.id, 'email_comms', 'v1-el')
    // OWNER connection (BYPASSRLS) so it is the INDEX being tested, not RLS.
    const chain = await errorChain(() =>
      db.insert(clientConsents).values({
        tenantId: tenantIdT,
        clientId: c.id,
        scope: 'email_comms',
        textVersion: 'v1-el',
      }),
    )
    expect(chain).toMatch(/unique|duplicate key/i)
    expect(chain).toMatch(/client_consents_one_active_per_scope/)
    expect(await rowsFor(c.id)).toHaveLength(1)
  })

  it('the index does not constrain across clients', async () => {
    const c1 = await createClient(userT, { firstName: 'One', lastName: 'O' })
    const c2 = await createClient(userT, { firstName: 'Two', lastName: 'T' })
    await granted(userT, c1.id, 'email_comms', 'v1-el')
    await granted(userT, c2.id, 'email_comms', 'v1-el')
    expect(await activeConsents(userT, c1.id)).toEqual(['email_comms'])
    expect(await activeConsents(userT, c2.id)).toEqual(['email_comms'])
  })

  it('after a chain of grants, one withdraw leaves zero active rows', async () => {
    const c = await createClient(userT, { firstName: 'Chain', lastName: 'C' })
    for (let i = 0; i < 3; i++) await granted(userT, c.id, 'portal_access', `v${i}-el`)
    expect(await withdrawConsent(userT, c.id, 'portal_access')).toBe(true)
    expect(await activeConsents(userT, c.id)).toEqual([])
    const rows = await rowsFor(c.id)
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.withdrawnAt === null), 'an active row survived').toHaveLength(0)
    // Exactly one withdraw audit row: the two earlier rows were superseded, and
    // a supersede is not audited as a withdrawal.
    expect((await consentAudits(c.id)).filter((r) => r.action === 'update')).toHaveLength(1)
  })

  it('a withdrawn row is never re-stamped by a later withdrawal', async () => {
    const c = await createClient(userT, { firstName: 'Stamp', lastName: 'S' })
    const g = await granted(userT, c.id, 'email_comms', 'v1-el')
    expect(await withdrawConsent(userT, c.id, 'email_comms')).toBe(true)
    const first = (await rowsFor(c.id)).find((r) => r.id === g.id)!
    expect(await withdrawConsent(userT, c.id, 'email_comms')).toBe(false)
    const second = (await rowsFor(c.id)).find((r) => r.id === g.id)!
    expect(second.withdrawnAt!.getTime()).toBe(first.withdrawnAt!.getTime())
  })
})

// ---------------------------------------------------------------------------
// 5. Requirement 4 — `scope` is `text` with no CHECK constraint and arrives as a
//    parameter, so a value out of parsed JSON reaches this service having
//    bypassed the TypeScript union entirely. Same defect class as Task 2's mass
//    assignment.
// ---------------------------------------------------------------------------
describe('scope is validated at runtime (req 4)', () => {
  const run = `${Date.now().toString(36)}-scp`
  const userS = `con-scp-${run}`
  let tenantIdS: string

  beforeAll(async () => {
    tenantIdS = await seed(`CON SCP ${run}`, [userS])
  })
  afterAll(() => reap(tenantIdS, [userS]))

  // How an unvalidated value actually arrives: JSON.parse has no idea about the
  // union, so the cast here is exactly what a route handler would do implicitly.
  const bogus = JSON.parse('"all_purposes"') as ConsentScope

  it('grantConsent rejects an unknown scope and writes nothing', async () => {
    const c = await createClient(userS, { firstName: 'Bogus', lastName: 'G' })
    const chain = await errorChain(() => grantConsent(userS, c.id, bogus, 'v1-el'))
    expect(chain).toMatch(/all_purposes/)
    expect(chain).toMatch(/scope/i)

    expect(await rowsFor(c.id)).toHaveLength(0)
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.clientId, c.id), eq(auditLog.entity, 'consent')))
    expect(audits, 'a rejected scope must not be audited as a consent event').toHaveLength(0)
  })

  it('withdrawConsent rejects an unknown scope', async () => {
    const c = await createClient(userS, { firstName: 'Bogus', lastName: 'W' })
    await granted(userS, c.id, 'email_comms', 'v1-el')
    const chain = await errorChain(() => withdrawConsent(userS, c.id, bogus))
    expect(chain).toMatch(/all_purposes/)
    // The real grant is untouched.
    expect(await activeConsents(userS, c.id)).toEqual(['email_comms'])
  })

  it('the empty string is not a scope', async () => {
    const c = await createClient(userS, { firstName: 'Empty', lastName: 'E' })
    const chain = await errorChain(() => grantConsent(userS, c.id, '' as ConsentScope, 'v1-el'))
    expect(chain).toMatch(/scope/i)
    expect(await rowsFor(c.id)).toHaveLength(0)
  })

  it('every declared scope is accepted', async () => {
    const c = await createClient(userS, { firstName: 'Valid', lastName: 'V' })
    for (const scope of CONSENT_SCOPES) {
      const row = await granted(userS, c.id, scope, 'v1-el')
      expect(row.scope).toBe(scope)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Requirement 5 — the per-client read/withdraw paths log a `deny` row when
//    the client is unreachable, carrying no attempted id (Task 3's owner
//    decision), and a membership-less caller is skipped rather than thrown.
// ---------------------------------------------------------------------------
describe('denied per-client consent access is audited (req 5)', () => {
  const run = `${Date.now().toString(36)}-dny`
  const userP = `con-dny-p-${run}` // prober
  const userV = `con-dny-v-${run}` // victim
  const userNone = `con-dny-n-${run}` // deliberately given no tenant_members row
  let tenantIdP: string
  let tenantIdV: string
  let victimClientId: string

  beforeAll(async () => {
    tenantIdP = await seed(`CON DNY P ${run}`, [userP])
    tenantIdV = await seed(`CON DNY V ${run}`, [userV])
    victimClientId = (await createClient(userV, { firstName: 'Victim', lastName: 'V' })).id
    await granted(userV, victimClientId, 'marketing', 'v1-el')
  })
  afterAll(async () => {
    await reap(tenantIdP, [userP])
    await reap(tenantIdV, [userV])
  })

  function denies(): Promise<AuditRow[]> {
    return withUser(userP, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'deny'), eq(auditLog.entity, 'consent'))),
    )
  }

  it('activeConsents on an unreachable client returns [] and writes a deny row', async () => {
    expect(await denies()).toHaveLength(0)

    expect(await activeConsents(userP, victimClientId)).toEqual([])

    const rows = await denies()
    expect(rows).toHaveLength(1)
    expect(rows[0].tenantId).toBe(tenantIdP)
    expect(rows[0].actorUserId).toBe(userP)
    expect(rows[0].entity).toBe('consent')
    expect(rows[0].entityId).toBeNull()
    expect(rows[0].clientId).toBeNull()
    expect(rows[0].metadata).toEqual({ outcome: 'denied' })
  })

  it('withdrawConsent on an unreachable client returns false and writes a deny row', async () => {
    const before = (await denies()).length

    expect(await withdrawConsent(userP, victimClientId, 'marketing')).toBe(false)

    expect(await denies()).toHaveLength(before + 1)
    // And the victim's consent is still live.
    expect(await activeConsents(userV, victimClientId)).toEqual(['marketing'])
    expect((await rowsFor(victimClientId)).filter((r) => r.withdrawnAt === null)).toHaveLength(1)
  })

  it('an unknown uuid counts as a denied attempt too', async () => {
    const before = (await denies()).length
    const ghost = crypto.randomUUID()
    expect(await activeConsents(userP, ghost)).toEqual([])
    expect(await withdrawConsent(userP, ghost, 'marketing')).toBe(false)
    expect(await denies()).toHaveLength(before + 2)
  })

  it('a membership-less caller gets the empty answer, no exception, no audit row', async () => {
    // recordDeny cannot attribute a tenant here, so it must skip rather than
    // throw — the trap that made listClients regress in Task 3.
    expect(await activeConsents(userNone, victimClientId)).toEqual([])
    expect(await withdrawConsent(userNone, victimClientId, 'marketing')).toBe(false)
    expect(await grantConsent(userNone, victimClientId, 'marketing', 'v1-el')).toBeNull()

    // Owner connection: userNone has no tenant, so it cannot read audit_log.
    const rows = await db.select().from(auditLog).where(eq(auditLog.actorUserId, userNone))
    expect(rows).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 7. Requirement 7 — isolation of the table itself (spec §7: allow-own,
//    deny-cross-read, deny-cross-insert, fail-closed on an empty user).
// ---------------------------------------------------------------------------
describe('client_consents tenant isolation (req 7)', () => {
  const run = `${Date.now().toString(36)}-iso`
  const userA = `con-iso-a-${run}`
  const userOther = `con-iso-o-${run}`
  let tenantIdA: string
  let tenantIdOther: string
  let clientIdA: string
  let consentIdA: string
  let consentIdOther: string

  beforeAll(async () => {
    tenantIdA = await seed(`CON ISO A ${run}`, [userA])
    tenantIdOther = await seed(`CON ISO O ${run}`, [userOther])
    clientIdA = (await createClient(userA, { firstName: 'Mine', lastName: 'M' })).id
    const clientIdOther = (await createClient(userOther, { firstName: 'Theirs', lastName: 'T' })).id
    consentIdA = (await granted(userA, clientIdA, 'email_comms', 'v1-el')).id
    consentIdOther = (await granted(userOther, clientIdOther, 'email_comms', 'v1-el')).id
  })
  afterAll(async () => {
    await reap(tenantIdA, [userA])
    await reap(tenantIdOther, [userOther])
  })

  it("another tenant sees its own consent rows but not this tenant's", async () => {
    const rows = await withUser(userOther, (tx) => tx.select().from(clientConsents))
    const ids = rows.map((r) => r.id)
    // Positive control first: without it an empty result passes for the wrong
    // reason (e.g. the policy denying everything).
    expect(ids).toContain(consentIdOther)
    expect(ids).not.toContain(consentIdA)
  })

  it('cross-tenant INSERT with a foreign tenant_id is rejected by WITH CHECK', async () => {
    const chain = await errorChain(() =>
      withUser(userOther, (tx) =>
        tx.insert(clientConsents).values({
          tenantId: tenantIdA,
          clientId: clientIdA,
          scope: 'marketing',
          textVersion: 'v1-el',
        }),
      ),
    )
    expect(chain).toMatch(/row-level security/i)
    expect(await rowsFor(clientIdA)).toHaveLength(1) // only the legitimate row
  })

  it("another tenant's UPDATE matches no row (RLS, not the grant)", async () => {
    const changed = await withUser(userOther, (tx) =>
      tx
        .update(clientConsents)
        .set({ withdrawnAt: sql`now()` })
        .where(eq(clientConsents.id, consentIdA))
        .returning({ id: clientConsents.id }),
    )
    expect(changed).toHaveLength(0)
    const [still] = await db.select().from(clientConsents).where(eq(clientConsents.id, consentIdA))
    expect(still.withdrawnAt, "another tenant withdrew this tenant's consent").toBeNull()
  })

  it("another tenant's DELETE matches no row", async () => {
    await withUser(userOther, (tx) =>
      tx.delete(clientConsents).where(eq(clientConsents.id, consentIdA)),
    )
    const rows = await db.select().from(clientConsents).where(eq(clientConsents.id, consentIdA))
    expect(rows).toHaveLength(1)
  })

  it('the consent-service refuses a cross-tenant client (service-level)', async () => {
    expect(await grantConsent(userOther, clientIdA, 'marketing', 'v1-el')).toBeNull()
    expect(await activeConsents(userOther, clientIdA)).toEqual([])
    expect(await withdrawConsent(userOther, clientIdA, 'email_comms')).toBe(false)
    expect((await rowsFor(clientIdA)).filter((r) => r.withdrawnAt === null)).toHaveLength(1)
  })

  it('empty userId sees zero consent rows (fail-closed)', async () => {
    const rows = await withUser('', (tx) => tx.select().from(clientConsents))
    expect(rows).toHaveLength(0)
  })

  it('a still-active consent is found by isNull, not by a magic sentinel', async () => {
    // Guards the column semantics the whole service reads: null = active.
    const rows = await withUser(userA, (tx) =>
      tx.select().from(clientConsents).where(isNull(clientConsents.withdrawnAt)),
    )
    expect(rows.map((r) => r.id)).toContain(consentIdA)
  })
})
