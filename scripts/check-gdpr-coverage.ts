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
 * WHY THIS IS A SCRIPT AND NOT A TEST. Its verdict depends on the CONTENTS of
 * `lib/gdpr.ts`, so moving a read into another module reds it while the code is
 * correct. Living in the suite developers run on save, that false red lands on
 * the person least able to act on it. It runs in CI instead, as
 * `pnpm check:gdpr`. The MECHANISM below is still covered by fixtures in
 * `tests/unit/gdpr-coverage.test.ts`, which import from this file — the fast
 * suite tests the analysis, CI applies the policy.
 *
 * WHY NOT AN ESLINT RULE. The check needs `getTableConfig` on a runtime-imported
 * `db/schema.ts`; Drizzle's table metadata is not visible to static analysis.
 * It also produces one whole-repo verdict rather than a per-file diagnostic.
 *
 * MECHANISM: a real TypeScript parse of `lib/gdpr.ts`. It maps every top-level
 * named code block to its body, then walks outward from each entry point,
 * following calls to other module-local blocks to a fixpoint, and collects the
 * identifiers used AS VALUES. `exportClient` reads `clients` only through the
 * `reachableClient` helper, so a check against the entry point's own body alone
 * would go red against correct code.
 *
 * This replaced a regex + brace-matching parser, which had documented gaps in
 * both directions: it silently dropped declaration styles it could not match
 * (expression-bodied and parenless arrows) and reported them as "not
 * referenced", and it counted comments, string literals and shorthand
 * properties as real references. The AST closes all of those — the repo already
 * made this same call once, for the `new Date` rule in eslint.config.mjs.
 *
 * WHAT IT STILL CANNOT SEE: a reference reached through a helper in ANOTHER
 * FILE. The block map is module-local by construction, so moving a table read
 * out of `lib/gdpr.ts` produces a false red — the failure message says so.
 *
 * POLICY SLOT (not built): a table that is legally retained — invoices, tax
 * records — stays REQUIRED in `exportClient` (Art 15 still owes it) and is
 * exempted only from `eraseClient`. That belongs in a sibling exemption map
 * consulted in the coverage loop, never as a silent omission from REGISTRY.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { allTables } from '@/db/introspect'

const HERE = dirname(fileURLToPath(import.meta.url))
const GDPR_PATH = resolve(HERE, '../lib/gdpr.ts')

export const ENTRY_POINTS = ['exportClient', 'eraseClient'] as const

/** table name -> the Drizzle export identifier `lib/gdpr.ts` refers to it by. */
export const REGISTRY: Record<string, string> = {
  clients: 'clients',
  client_consents: 'clientConsents',
  measurements: 'measurements',
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
  return allTables(schema)
    .filter((cfg) => cfg.name === 'clients' || cfg.columns.some((c) => c.name === 'client_id'))
    .map((cfg) => cfg.name)
}

/**
 * name -> body node, for every top-level named code block: function
 * declarations, and consts initialised with an arrow or function expression.
 * A parser rather than a pattern match, so declaration style cannot change the
 * answer — an expression-bodied arrow has a body node just like a braced one.
 *
 * Class methods and `export default` are deliberately out of scope: `lib/gdpr.ts`
 * has neither, and a block that is never in the map can only cause a false RED
 * ("not referenced"), never a false green.
 */
export function namedBlocks(src: string): Map<string, ts.Node> {
  const sf = ts.createSourceFile('gdpr.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const blocks = new Map<string, ts.Node>()

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      if (stmt.name && stmt.body) blocks.set(stmt.name.text, stmt.body)
      continue
    }
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      const init = decl.initializer
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        blocks.set(decl.name.text, init.body)
      }
    }
  }
  return blocks
}

/**
 * Identifiers used AS VALUES inside a node. The exclusions are the whole point:
 * each one is a way to spell a table's name without reading the table, and each
 * was a false green in the regex version.
 */
function valueIdentifiers(node: ts.Node, out: Set<string>): void {
  const visit = (n: ts.Node): void => {
    // A type position never reads a table. Covers annotations, `typeof x`,
    // type arguments and the type half of an `as` expression.
    if (ts.isTypeNode(n)) return

    // `{ auditLog: audit }` — a property KEY, not a use. Visit only the value.
    if (ts.isPropertyAssignment(n)) {
      visit(n.initializer)
      return
    }

    // `{ auditLog }` — names the binding without querying it.
    if (ts.isShorthandPropertyAssignment(n)) return

    // `a.auditLog` — `auditLog` is a member name here, not a free identifier.
    if (ts.isPropertyAccessExpression(n)) {
      visit(n.expression)
      return
    }

    if (ts.isIdentifier(n)) {
      out.add(n.text)
      return
    }
    n.forEachChild(visit)
  }
  visit(node)
}

/**
 * Every value identifier reachable from an entry point: its own body plus, to a
 * fixpoint, the bodies of every module-local block it calls. Cycle-safe.
 */
export function reachableIdentifiers(blocks: Map<string, ts.Node>, entry: string): Set<string> {
  const own = blocks.get(entry)
  if (own === undefined) {
    throw new Error(
      `entry point "${entry}" not found in lib/gdpr.ts — either it was renamed ` +
        '(update ENTRY_POINTS in scripts/check-gdpr-coverage.ts) or it is declared ' +
        'in a form this gate does not map (a class method, or export default)',
    )
  }

  const idents = new Set<string>()
  const visited = new Set([entry])
  const queue: ts.Node[] = [own]

  while (queue.length > 0) {
    const found = new Set<string>()
    valueIdentifiers(queue.pop()!, found)
    for (const id of found) {
      idents.add(id)
      const body = blocks.get(id)
      if (body !== undefined && !visited.has(id)) {
        visited.add(id)
        queue.push(body)
      }
    }
  }

  if (idents.size === 0) {
    throw new Error(`no identifiers reachable from "${entry}" — the parser is broken, not the code`)
  }
  return idents
}

export function findViolations(opts: {
  src: string
  tables: string[]
  registry?: Record<string, string>
  entryPoints?: readonly string[]
}): Violation[] {
  const registry = opts.registry ?? REGISTRY
  const entryPoints = opts.entryPoints ?? ENTRY_POINTS
  const blocks = namedBlocks(opts.src)
  const reachable = new Map(
    entryPoints.map((e) => [e, reachableIdentifiers(blocks, e)] as const),
  )
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
      if (!reachable.get(entry)!.has(ident)) {
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
        '     only checks that the identifier is used, never that it is used right.\n' +
        '  3. Register it in REGISTRY in scripts/check-gdpr-coverage.ts:\n' +
        `     '${v.table}': '<drizzleExport>'.\n` +
        'If the table is legally retained and must NOT be erased, that is a policy\n' +
        'decision — do not silence this gate; see the POLICY SLOT note above.'
      )
    case 'uncovered':
      return (
        `Table "${v.table}" (identifier \`${v.ident}\`) is never used as a value in\n` +
        `${v.entry} in lib/gdpr.ts, nor in any helper it calls within that file.\n` +
        'Helpers called from it WITHIN lib/gdpr.ts count, so a read extracted into a\n' +
        'local helper is fine. An import, a type annotation, a comment, a string, a\n' +
        'property key and a `{ shorthand }` do NOT count — none of them reads the\n' +
        'table. Helpers in OTHER files are invisible: if you moved this read into\n' +
        'another module, this red is a false alarm — inline the reference or extend\n' +
        'this gate to follow that module.'
      )
    case 'missing-from-schema':
      return (
        `Table "${v.table}" is registered in this gate but db/schema.ts no longer\n` +
        'reports it as client-scoped. Either it was dropped or renamed (update\n' +
        'REGISTRY in scripts/check-gdpr-coverage.ts), it lost its `client_id`\n' +
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
        'if the module moved, update GDPR_PATH in scripts/check-gdpr-coverage.ts',
      { cause },
    )
  }
}

async function main(): Promise<number> {
  const schema = await import('@/db/schema')
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
// `.then` rather than top-level await: this file has no `.mts` extension and the
// package is not `"type": "module"`, so tsx transpiles it as CJS, where a
// top-level await is a hard error. Setting exitCode (not process.exit) lets
// stdout/stderr flush before the process ends.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (err: unknown) => {
      console.error(err)
      process.exitCode = 1
    },
  )
}
