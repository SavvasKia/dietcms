import { describe, expect, it } from 'vitest'
import {
  effectiveBody,
  findViolations,
  formatViolation,
  namedBodies,
  references,
  referencesTable,
} from '../../scripts/check-gdpr-coverage.mts'

/**
 * Tests for the MECHANISM of the GDPR coverage gate, not for the gate's verdict
 * against the live `lib/gdpr.ts`. That verdict is a policy check that reds on
 * ordinary rename/style churn, so it runs in CI as `pnpm check:gdpr` and is
 * deliberately absent from the suite developers run on save.
 *
 * Everything here is fixture-based on purpose: asserting against the real
 * `lib/gdpr.ts` would turn a legitimate inlining or extraction of a table read
 * into a false red in the fast suite — the exact coupling this split removes.
 */

const WIRED = `
  import { clients, clientConsents, auditLog } from '@/db/schema'
  export async function exportClient(id: string) {
    const client = await reachableClient(id)
    const consents = await db.select().from(clientConsents)
    const audit = await db.select().from(auditLog)
    return { client, consents, auditLog: audit }
  }
  export async function eraseClient(id: string) {
    await reachableClient(id)
    await db.delete(clientConsents)
    await db.update(auditLog).set({})
    return true
  }
  const reachableClient = async (id: string) => {
    return db.select().from(clients).where(eq(clients.id, id))
  }
`

const REGISTRY = { clients: 'clients', client_consents: 'clientConsents', audit_log: 'auditLog' }
const TABLES = ['clients', 'client_consents', 'audit_log']

describe('findViolations', () => {
  it('reports nothing when every registered table is reachable from both entry points', () => {
    expect(findViolations({ src: WIRED, tables: TABLES, registry: REGISTRY })).toEqual([])
  })

  it('flags a client-scoped table that is not registered', () => {
    const v = findViolations({
      src: WIRED,
      tables: [...TABLES, 'client_documents'],
      registry: REGISTRY,
    })
    expect(v).toEqual([{ kind: 'unregistered', table: 'client_documents' }])
    expect(formatViolation(v[0])).toMatch(/client_documents/)
  })

  it('flags a registered table that no entry point reaches', () => {
    const src = WIRED.replace('const audit = await db.select().from(auditLog)', 'const audit = []')
    const v = findViolations({ src, tables: TABLES, registry: REGISTRY })
    expect(v).toEqual([
      { kind: 'uncovered', table: 'audit_log', ident: 'auditLog', entry: 'exportClient' },
    ])
  })

  it('flags a registered table that has vanished from the schema', () => {
    // Guards the vacuous pass: if table discovery silently returned nothing, every
    // coverage assertion below it would be satisfied by an empty loop.
    const v = findViolations({ src: WIRED, tables: [], registry: REGISTRY })
    expect(v.map((x) => x.kind)).toEqual(['missing-from-schema', 'missing-from-schema', 'missing-from-schema'])
  })
})

describe('source traversal', () => {
  it('resolves a reference reachable only through a module-local helper', () => {
    // Regression test for the real bug this gate was written around: checking
    // exportClient's own body alone reported `clients` as uncovered, because the
    // read is delegated to reachableClient. Both declaration styles and a cycle
    // are covered.
    const fixture = `
      import { alpha, beta } from '@/db/schema'
      export async function entry(a: string) {
        return helper(a)
      }
      const helper = async (a: string) => {
        loop(a)
        return read(alpha)
      }
      function loop(a: string) {
        return helper(a) // cycle: helper -> loop -> helper
      }
      export const read = (t: unknown) => {
        return use(beta, t)
      }
    `
    const bodies = namedBodies(fixture)
    expect([...bodies.keys()]).toEqual(expect.arrayContaining(['entry', 'helper', 'loop', 'read']))
    const body = effectiveBody(bodies, 'entry')
    expect(references(body, 'alpha')).toBe(true) // one hop
    expect(references(body, 'beta')).toBe(true) // two hops, through a cycle
  })

  it('does not count an import-only or type-only reference as coverage', () => {
    const fixture = `
      import { orphan, used } from '@/db/schema'
      export type Shape = { row: typeof orphan.$inferSelect }
      export async function entry() {
        return read(used)
      }
      function read(t: unknown) {
        return t
      }
    `
    const body = effectiveBody(namedBodies(fixture), 'entry')
    expect(references(body, 'used')).toBe(true)
    expect(references(body, 'orphan')).toBe(false)
  })

  it('does not count a property key as a table reference', () => {
    // `return { client, consents, auditLog: audit }` in exportClient spells the
    // identifier without reading the table; without the exclusion, deleting the
    // audit read from exportClient stayed green off that key alone.
    const body = '{ return { rows, auditLog: audit } }'
    expect(references(body, 'auditLog')).toBe(true) // loose: traversal match
    expect(referencesTable(body, 'auditLog')).toBe(false) // strict: table check
    expect(referencesTable('{ from(auditLog).where(eq(auditLog.clientId, x)) }', 'auditLog')).toBe(
      true,
    )
  })

  it('throws loudly rather than passing when an entry point is missing', () => {
    expect(() =>
      effectiveBody(namedBodies('function other() { return 1 }'), 'exportClient'),
    ).toThrow(/entry point "exportClient" not found/)
  })
})
