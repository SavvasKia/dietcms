import { describe, expect, it } from 'vitest'
import {
  findViolations,
  formatViolation,
  namedBlocks,
  reachableIdentifiers,
} from '../../scripts/check-gdpr-coverage'

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

const reached = (src: string, entry: string) => reachableIdentifiers(namedBlocks(src), entry)

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
    expect(v.map((x) => x.kind)).toEqual([
      'missing-from-schema',
      'missing-from-schema',
      'missing-from-schema',
    ])
  })
})

describe('reachability', () => {
  it('resolves a reference reachable only through a module-local helper', () => {
    // Regression test for the real bug this gate was written around: checking
    // exportClient's own body alone reported `clients` as uncovered, because the
    // read is delegated to reachableClient.
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
    expect([...namedBlocks(fixture).keys()]).toEqual(
      expect.arrayContaining(['entry', 'helper', 'loop', 'read']),
    )
    const ids = reached(fixture, 'entry')
    expect(ids.has('alpha')).toBe(true) // one hop
    expect(ids.has('beta')).toBe(true) // two hops, through a cycle
  })

  it('handles declaration styles the old brace-matching parser could not', () => {
    // Expression-bodied and parenless arrows had no `{` to match, so the previous
    // regex parser silently dropped them from the map and reported "not
    // referenced" when the truth was "not parsed". A real parser has no such gap.
    const fixture = `
      import { alpha, beta, gamma } from '@/db/schema'
      export function entry(): Record<string, unknown> {
        return { a: expr(), b: parenless(1), c: annotated() }
      }
      const expr = () => read(alpha)
      const parenless = (n: number) => read(beta, n)
      const annotated: () => { nested: string } = () => ({ nested: read(gamma) })
      function read(...xs: unknown[]) {
        return xs
      }
    `
    const ids = reached(fixture, 'entry')
    expect(ids.has('alpha')).toBe(true) // expression-bodied arrow
    expect(ids.has('beta')).toBe(true) // parenless single param
    expect(ids.has('gamma')).toBe(true) // brace inside a return-type annotation
  })

  it('does not count an import-only or type-only reference as coverage', () => {
    const fixture = `
      import { orphan, used } from '@/db/schema'
      export type Shape = { row: typeof orphan.$inferSelect }
      export async function entry() {
        const typed: typeof orphan.$inferSelect | null = null
        return read(used, typed)
      }
      function read(t: unknown, u: unknown) {
        return [t, u]
      }
    `
    const ids = reached(fixture, 'entry')
    expect(ids.has('used')).toBe(true)
    // Present in an import, a type alias AND a type annotation inside the body —
    // none of which is a use of the table.
    expect(ids.has('orphan')).toBe(false)
  })

  it('does not count a property key, a string, or a comment as a reference', () => {
    // `return { client, consents, auditLog: audit }` spells the identifier without
    // reading the table. Strings and comments are not nodes at all, so unlike the
    // regex version they cannot satisfy the check even by accident.
    const fixture = `
      import { auditLog } from '@/db/schema'
      export function entry() {
        // auditLog is mentioned in this comment
        const label = 'auditLog'
        return { label, auditLog: computed() }
      }
      function computed() {
        return 1
      }
    `
    expect(reached(fixture, 'entry').has('auditLog')).toBe(false)
  })

  it('does not count a shorthand property as a reference', () => {
    // `{ auditLog }` names the binding without querying the table. The regex
    // version counted this, so deleting a read but keeping it in the returned
    // object stayed green — a false pass the AST closes.
    const fixture = `
      import { auditLog, clients } from '@/db/schema'
      export function entry() {
        const rows = db.select().from(clients)
        return { rows, auditLog }
      }
    `
    const ids = reached(fixture, 'entry')
    expect(ids.has('clients')).toBe(true) // a real read, so the walk did run
    expect(ids.has('auditLog')).toBe(false)
  })

  it('counts a real query use', () => {
    const fixture = `
      import { auditLog } from '@/db/schema'
      export function entry() {
        return db.select().from(auditLog).where(eq(auditLog.clientId, 1))
      }
    `
    expect(reached(fixture, 'entry').has('auditLog')).toBe(true)
  })

  it('throws loudly rather than passing when an entry point is missing', () => {
    expect(() => reached('function other() { return 1 }', 'exportClient')).toThrow(
      /entry point "exportClient" not found/,
    )
  })
})
