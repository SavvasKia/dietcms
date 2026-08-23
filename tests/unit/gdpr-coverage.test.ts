import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

/**
 * A TRIPWIRE, not a proof of correctness.
 *
 * It forces a future client-scoped table (the `clients` root, or anything with a
 * `client_id` column) to be registered here AND referenced from both
 * `exportClient` and `eraseClient` in `lib/gdpr.ts`. It says nothing about
 * whether that wiring is CORRECT — that proof is behavioural and lives in
 * `tests/integration/gdpr.test.ts` (seed -> export-contains / erase-empties).
 * Do not read a green run here as "GDPR coverage is fine".
 *
 * Mechanism: source-text inspection of `lib/gdpr.ts`. It maps every top-level
 * named code block (function declarations and arrow consts) to its body, then
 * computes each entry point's EFFECTIVE body — its own body plus, to a fixpoint,
 * the bodies of every module-local block it reaches. `exportClient` reads
 * `clients` only through the `reachableClient` helper, so a check against the
 * entry point's own body alone would go red against correct code.
 *
 * Import lines belong to no body, so an import-only (or type-only) reference
 * still does NOT satisfy the check. That property is load-bearing.
 *
 * A reference reached through a helper in ANOTHER FILE is invisible to this
 * test: the bodies map is module-local by construction. Moving a table read out
 * of `lib/gdpr.ts` produces a false red — the failure messages below say so.
 */

// Resolved from this file, not from cwd: `readFileSync` rejects the jsdom `URL`
// global that `new URL(..., import.meta.url)` would produce under this suite.
const GDPR_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../lib/gdpr.ts')

const ENTRY_POINTS = ['exportClient', 'eraseClient'] as const

/** table name -> the Drizzle export identifier `lib/gdpr.ts` refers to it by. */
const tableToIdent: Record<string, string> = {
  clients: 'clients',
  client_consents: 'clientConsents',
  audit_log: 'auditLog',
}

function readGdprSource(): string {
  try {
    return readFileSync(GDPR_PATH, 'utf8')
  } catch (cause) {
    throw new Error(
      'cannot read lib/gdpr.ts — this coverage tripwire is coupled to that path; ' +
        'if the module moved, update GDPR_PATH in tests/unit/gdpr-coverage.test.ts',
      { cause },
    )
  }
}

/**
 * Tables holding data about a client: the `clients` root plus anything carrying
 * a `client_id` column.
 */
export function clientScopedTables(schema: Record<string, unknown>): string[] {
  const names: string[] = []
  for (const value of Object.values(schema)) {
    let cfg
    try {
      cfg = getTableConfig(value as never)
    } catch {
      continue // not a drizzle table
    }
    const cols = cfg.columns.map((c) => c.name)
    if (cfg.name === 'clients' || cols.includes('client_id')) names.push(cfg.name)
  }
  return names
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const references = (text: string, ident: string) =>
  new RegExp(`\\b${escapeRe(ident)}\\b`).test(text)

/** Index of the `{` opening a body, scanning past a balanced parameter list. */
function bodyBraceIndex(src: string, parenIndex: number, arrow: boolean): number {
  let depth = 0
  let i = parenIndex
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) {
        i++
        break
      }
    }
  }
  if (depth !== 0) return -1
  if (arrow) {
    // Require the arrow between the params and the body, so `const x = (a + b)`
    // or an immediately-invoked call is not mistaken for a code block.
    const arrowAt = src.indexOf('=>', i)
    if (arrowAt === -1) return -1
    const brace = src.indexOf('{', arrowAt)
    // Only an expression separates `=>` from a block body's `{`.
    return src.slice(arrowAt + 2, brace === -1 ? undefined : brace).trim() === '' ? brace : -1
  }
  return src.indexOf('{', i)
}

/** Brace-matched text from `open` (inclusive) to its closing `}` (inclusive). */
function braceMatch(src: string, open: number): string | null {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return null
}

/**
 * name -> body text, for every top-level named code block. Both declaration
 * styles are covered so a refactor between them cannot silently change the
 * answer:
 *   [export] [async] function NAME (...) { ... }
 *   [export] const NAME = [async] (...) => { ... }
 */
export function namedBodies(src: string): Map<string, string> {
  const bodies = new Map<string, string>()
  const decl =
    /(?:^|\n)\s*(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s+)?\()/g
  for (const m of src.matchAll(decl)) {
    const name = m[1] ?? m[2]
    const isArrow = m[2] !== undefined
    const paren = isArrow ? src.indexOf('(', m.index + m[0].length - 1) : src.indexOf('(', m.index)
    if (paren === -1) continue
    const brace = bodyBraceIndex(src, paren, isArrow)
    if (brace === -1) continue
    const body = braceMatch(src, brace)
    if (body === null) throw new Error(`unbalanced braces parsing ${name} in lib/gdpr.ts`)
    bodies.set(name, body)
  }
  return bodies
}

/**
 * The entry point's own body plus the bodies of every mapped name reachable from
 * it, to a fixpoint. Cycle-safe via the visited set.
 */
export function effectiveBody(bodies: Map<string, string>, entry: string): string {
  const own = bodies.get(entry)
  if (own === undefined) {
    throw new Error(
      `entry point "${entry}" not found in lib/gdpr.ts — either it was renamed ` +
        '(update ENTRY_POINTS in tests/unit/gdpr-coverage.test.ts) or its ' +
        'declaration style is one this test cannot parse',
    )
  }
  const visited = new Set([entry])
  let text = own
  for (let grew = true; grew; ) {
    grew = false
    for (const [name, body] of bodies) {
      if (visited.has(name) || !references(text, name)) continue
      visited.add(name)
      text += `\n${body}`
      grew = true
    }
  }
  if (text.replace(/[\s{}]/g, '').length === 0) {
    throw new Error(`effective body of "${entry}" is empty — the parser is broken, not the code`)
  }
  return text
}

describe('GDPR coverage tripwire', () => {
  const src = readGdprSource()
  const bodies = namedBodies(src)
  const effective = new Map(ENTRY_POINTS.map((e) => [e, effectiveBody(bodies, e)] as const))

  it('every client-scoped table is wired into BOTH exportClient and eraseClient', async () => {
    const schema = await import('@/db/schema')
    const tables = clientScopedTables(schema)

    // Guards the loop below: an empty `tables` (e.g. getTableConfig starting to
    // throw for every entry) would otherwise satisfy every assertion vacuously.
    expect(tables).toEqual(expect.arrayContaining(['clients', 'client_consents', 'audit_log']))

    for (const table of tables) {
      const ident = tableToIdent[table]
      expect(
        ident,
        `Table "${table}" holds client data but is not registered in this test.\n` +
          'A client-scoped table (the `clients` root, or any table with a `client_id`\n' +
          'column) must be covered by GDPR export and erasure. Do all three:\n' +
          `  1. Read it in exportClient (Art 15/20) and delete-or-anonymize it in\n` +
          '     eraseClient (Art 17) in lib/gdpr.ts.\n' +
          '  2. Add a behavioural case to tests/integration/gdpr.test.ts — this test\n' +
          '     only checks that the identifier appears, never that it is used right.\n' +
          `  3. Register it in tableToIdent in this file: '${table}': '<drizzleExport>'.\n` +
          'If the table is legally retained and must NOT be erased, that is a policy\n' +
          'decision — do not silence this test; see the POLICY SLOT note in lib/gdpr.ts.',
      ).toBeTruthy()

      for (const entry of ENTRY_POINTS) {
        expect(
          references(effective.get(entry)!, ident),
          `Table "${table}" (identifier \`${ident}\`) is not referenced anywhere in\n` +
            `${entry}'s effective body in lib/gdpr.ts.\n` +
            'The effective body includes helpers called from it WITHIN lib/gdpr.ts, so a\n' +
            'read extracted into a local helper still counts. It does NOT include the\n' +
            'import block, nor helpers living in other files: if you moved this read into\n' +
            'another module, this red is a false alarm — inline the reference or extend\n' +
            'this test to follow that module.',
        ).toBe(true)
      }
    }
  })

  it('resolves a reference reachable only through a module-local helper', () => {
    // Regression test for the real bug this file was written around: checking
    // exportClient's own body alone reported `clients` as uncovered, because the
    // read is delegated to reachableClient. Fixture-based on purpose — asserting
    // against lib/gdpr.ts would turn a legitimate inlining of that read into a
    // false red. Both declaration styles and a cycle are covered.
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
    expect([...bodies.keys()]).toEqual(
      expect.arrayContaining(['entry', 'helper', 'loop', 'read']),
    )
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

  it('throws loudly rather than passing when an entry point is missing', () => {
    expect(() => effectiveBody(namedBodies('function other() { return 1 }'), 'exportClient')).toThrow(
      /entry point "exportClient" not found/,
    )
  })
})
