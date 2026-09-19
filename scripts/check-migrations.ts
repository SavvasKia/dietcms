/**
 * Migrations are in sync with db/schema.ts.
 *
 * Runs `drizzle-kit generate` and fails if it produced anything. A new file
 * means db/schema.ts declares something no migration creates — so the change
 * exists only in TypeScript, every DB-free gate still passes, and the first
 * symptom is a runtime error against a database that was never migrated.
 *
 * tests/unit/consent-scope-check.test.ts catches this for the consent CHECK
 * specifically, by comparing the migration SQL to CONSENT_SCOPES. This is the
 * general form: it covers every table, index and constraint without anyone
 * writing a per-object assertion. That matters because the same commit that
 * added the CHECK also added six indexes, none of which had such a test.
 *
 * Generation is a pure schema-vs-snapshot diff — drizzle-kit does not connect
 * to a database for `generate` — so this runs with no credentials, which is the
 * whole point: it belongs in the always-on job, not behind the Neon secrets.
 *
 * The tree is restored exactly as found before exiting — new files deleted AND
 * modified ones rewritten. Both halves matter: generation appends an entry to
 * meta/_journal.json, so deleting only the new files would leave the journal
 * dirty and the next run would disagree with git. Fix drift by running
 * `pnpm db:generate` yourself and committing the result, never by re-running
 * this.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'db', 'migrations')

/** Every file under db/migrations, relative path -> contents, including meta/. */
function snapshot(dir: string, prefix = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (statSync(full).isDirectory()) {
      for (const [k, v] of snapshot(full, rel)) out.set(k, v)
    } else {
      out.set(rel, readFileSync(full))
    }
  }
  return out
}

const before = snapshot(MIGRATIONS)

try {
  execFileSync('pnpm', ['exec', 'drizzle-kit', 'generate'], {
    stdio: 'pipe',
    shell: process.platform === 'win32',
  })
} catch (err) {
  console.error('check:migrations — `drizzle-kit generate` failed:\n')
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}

const after = snapshot(MIGRATIONS)
const created = [...after.keys()].filter((f) => !before.has(f)).sort()

// Restore before reporting, so an early return cannot leak a dirty tree. New
// files go; pre-existing ones are rewritten only if generation changed them
// (meta/_journal.json always is, when anything was generated).
for (const f of created) rmSync(join(MIGRATIONS, f), { force: true })
for (const [f, content] of before) {
  if (!after.get(f)?.equals(content)) writeFileSync(join(MIGRATIONS, f), content)
}

if (created.length === 0) {
  console.log('check:migrations — OK. db/schema.ts matches the committed migrations.')
  process.exit(0)
}

console.error(
  'check:migrations — db/schema.ts has changes with no migration.\n\n' +
    `Generating produced ${created.length} new file(s):\n` +
    created.map((f) => `  ${f}`).join('\n') +
    '\n\n(those were deleted again — this check never leaves files behind)\n\n' +
    'Something in db/schema.ts — a table, column, index or constraint — exists\n' +
    'only in TypeScript. Typecheck, lint and the unit suite all pass on such a\n' +
    'change, and no database would have it. Run `pnpm db:generate` and commit\n' +
    'the migration together with the schema edit.',
)
process.exit(1)
