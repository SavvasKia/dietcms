/**
 * GDPR coverage gate — a TRIPWIRE, not a proof of correctness.
 *
 * It forces a future client-scoped table (the `clients` root, or anything with a
 * `client_id` column) to be registered here AND referenced from both
 * `exportClient` and `eraseClient` in `lib/gdpr.ts`. It says nothing about
 * whether that wiring is CORRECT — that proof is behavioural and lives in
 * `tests/integration/gdpr.test.ts` (seed -> export-contains / erase-empties).
 * Do not read a green run here as "GDPR coverage is fine".
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. It is a lint rule wearing a test's
 * clothes: its verdict depends on the source TEXT of `lib/gdpr.ts`, so ordinary
 * rename and style churn can red it while the code is correct. Living in the
 * suite developers run on save, that false red lands on the person least able to
 * act on it. It runs in CI instead, as `pnpm check:gdpr`. The MECHANISM below is
 * still covered by fixtures in `tests/unit/gdpr-coverage.test.ts`, which import
 * from this file — the fast suite tests the parser, CI applies the policy.
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
 * A reference reached through a helper in ANOTHER FILE is invisible here: the
 * bodies map is module-local by construction. Moving a table read out of
 * `lib/gdpr.ts` produces a false red — the failure messages below say so.
 *
 * POLICY SLOT (not built): a table that is legally retained — invoices, tax
 * records — stays REQUIRED in `exportClient` (Art 15 still owes it) and is
 * exempted only from `eraseClient`. That belongs in a sibling exemption map
 * consulted in the coverage loop, never as a silent omission from REGISTRY.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableConfig } from 'drizzle-orm/pg-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const GDPR_PATH = resolve(HERE, '../lib/gdpr.ts')

export const ENTRY_POINTS = ['exportClient', 'eraseClient'] as const

/** table name -> the Drizzle export identifier `lib/gdpr.ts` refers to it by. */
export const REGISTRY: Record<string, string> = {
  clients: 'clients',
  client_consents: 'clientConsents',
  audit_log: 'auditLog',
}

export type Violation =
  | { kind: 'unregistered'; table: string }
  | { kind: 'uncovered'; table: string; ident: string; entry: string }
  | { kind: 'missing-from-schema'; table: string; ident: string }

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

/** Loose match, used for helper-name traversal: over-reaching here costs nothing. */
export const references = (text: string, ident: string) =>
  new RegExp(`\\b${escapeRe(ident)}\\b`).test(text)

/**
 * Match for the table check. Excludes `ident:` — a property KEY, not a use of
 * the table. Without this, `return { client, consents, auditLog: audit }` alone
 * keeps `audit_log` green in `exportClient` even after the read is deleted.
 * Still satisfiable by `{ auditLog }` shorthand or a comment naming the
 * identifier: this is a tripwire for absence, not an assertion of use.
 */
export const referencesTable = (text: string, ident: string) =>
  new RegExp(`\\b${escapeRe(ident)}\\b(?!\\s*:)`).test(text)

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
        '(update ENTRY_POINTS in scripts/check-gdpr-coverage.mts) or its ' +
        'declaration style is one this parser cannot handle',
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

export function findViolations(opts: {
  src: string
  tables: string[]
  registry?: Record<string, string>
  entryPoints?: readonly string[]
}): Violation[] {
  const registry = opts.registry ?? REGISTRY
  const entryPoints = opts.entryPoints ?? ENTRY_POINTS
  const bodies = namedBodies(opts.src)
  const effective = new Map(entryPoints.map((e) => [e, effectiveBody(bodies, e)] as const))
  const violations: Violation[] = []

  // A registered table that discovery no longer reports is the vacuous-pass
  // guard: if table discovery silently returned nothing, every coverage check
  // below would be satisfied by an empty loop.
  for (const [table, ident] of Object.entries(registry)) {
    if (!opts.tables.includes(table)) violations.push({ kind: 'missing-from-schema', table, ident })
  }

  for (const table of opts.tables) {
    const ident = registry[table]
    if (ident === undefined) {
      violations.push({ kind: 'unregistered', table })
      continue
    }
    for (const entry of entryPoints) {
      if (!referencesTable(effective.get(entry)!, ident)) {
        violations.push({ kind: 'uncovered', table, ident, entry })
      }
    }
  }
  return violations
}

export function formatViolation(v: Violation): string {
  switch (v.kind) {
    case 'unregistered':
      return (
        `Table "${v.table}" holds client data but is not registered in this gate.\n` +
        'A client-scoped table (the `clients` root, or any table with a `client_id`\n' +
        'column) must be covered by GDPR export and erasure. Do all three:\n' +
        '  1. Read it in exportClient (Art 15/20) and delete-or-anonymize it in\n' +
        '     eraseClient (Art 17) in lib/gdpr.ts.\n' +
        '  2. Add a behavioural case to tests/integration/gdpr.test.ts — this gate\n' +
        '     only checks that the identifier appears, never that it is used right.\n' +
        '  3. Register it in REGISTRY in scripts/check-gdpr-coverage.mts:\n' +
        `     '${v.table}': '<drizzleExport>'.\n` +
        'If the table is legally retained and must NOT be erased, that is a policy\n' +
        'decision — do not silence this gate; see the POLICY SLOT note above.'
      )
    case 'uncovered':
      return (
        `Table "${v.table}" (identifier \`${v.ident}\`) is not referenced anywhere in\n` +
        `${v.entry}'s effective body in lib/gdpr.ts.\n` +
        'The effective body includes helpers called from it WITHIN lib/gdpr.ts, so a\n' +
        'read extracted into a local helper still counts. It does NOT include the\n' +
        'import block, nor helpers living in other files: if you moved this read into\n' +
        'another module, this red is a false alarm — inline the reference or extend\n' +
        'this gate to follow that module.'
      )
    case 'missing-from-schema':
      return (
        `Table "${v.table}" is registered in this gate but db/schema.ts no longer\n` +
        'reports it as client-scoped. Either it was dropped or renamed (update\n' +
        'REGISTRY in scripts/check-gdpr-coverage.mts), it lost its `client_id`\n' +
        'column, or table discovery itself broke. Do NOT just delete the entry: an\n' +
        'empty discovery list would make every coverage check below pass vacuously.'
      )
  }
}

function readGdprSource(): string {
  try {
    return readFileSync(GDPR_PATH, 'utf8')
  } catch (cause) {
    throw new Error(
      'cannot read lib/gdpr.ts — this coverage gate is coupled to that path; ' +
        'if the module moved, update GDPR_PATH in scripts/check-gdpr-coverage.mts',
      { cause },
    )
  }
}

async function main(): Promise<number> {
  const schema = await import('../db/schema.ts')
  const tables = clientScopedTables(schema as Record<string, unknown>)
  const violations = findViolations({ src: readGdprSource(), tables })

  if (violations.length === 0) {
    console.log(
      `check:gdpr — OK. ${tables.length} client-scoped table(s) wired into ` +
        `${ENTRY_POINTS.join(' and ')}: ${tables.join(', ')}.\n` +
        'This is a tripwire for absence, not proof of correctness — the behavioural\n' +
        'proof is tests/integration/gdpr.test.ts.',
    )
    return 0
  }

  console.error(`check:gdpr — ${violations.length} violation(s).\n`)
  for (const v of violations) console.error(`${formatViolation(v)}\n`)
  return 1
}

// Run only when invoked directly; the unit tests import the mechanism above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
