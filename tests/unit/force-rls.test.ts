import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as schema from '@/db/schema'
import { allTables } from '@/db/introspect'

/**
 * Every RLS table is also FORCEd.
 *
 * `ALTER TABLE x ENABLE ROW LEVEL SECURITY` exempts the table OWNER from its own
 * policies. The owner connection (db/client.ts) is exactly what runs migrations
 * and eraseClient's audit anonymization, so without FORCE the isolation proof
 * covers only the request role and a single owner-path query can read across
 * every tenant.
 *
 * This is the gap NO other gate can see. `.enableRLS()` in db/schema.ts emits
 * ENABLE and nothing else — drizzle-kit has no concept of FORCE — so the
 * statement has been appended BY HAND to every migration since 0001, and
 * `pnpm check:migrations` is blind to it because it is not in the snapshot
 * drizzle diffs against. The next new RLS table would ship un-FORCEd with every
 * gate green, which is precisely how this was caught: migration 0009 as
 * generated was missing it.
 *
 * Parsing the SQL on disk is the point (same shape as consent-scope-check):
 * both sides must be real second copies, or the test compares a value to
 * itself. The schema says which tables MUST be forced; the migrations say which
 * ones ARE.
 */

const MIGRATIONS = join(process.cwd(), 'db', 'migrations')

/** Table names that `.enableRLS()` marks in db/schema.ts. */
function rlsTablesFromSchema(): string[] {
  return allTables(schema as Record<string, unknown>)
    .filter((cfg) => cfg.enableRLS)
    .map((cfg) => cfg.name)
    .sort()
}

/** Table names carrying a FORCE ROW LEVEL SECURITY statement in any migration. */
function forcedTablesFromMigrations(): Set<string> {
  const forced = new Set<string>()
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+"?([\w.]+)"?\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi)) {
      forced.add(m[1])
    }
  }
  return forced
}

describe('FORCE ROW LEVEL SECURITY', () => {
  // The vacuous-pass guard. If table discovery or the RLS flag ever returns
  // nothing, the assertion below would pass over an empty list and this file
  // would go green while proving nothing.
  it('finds the RLS tables it is supposed to check', () => {
    const tables = rlsTablesFromSchema()
    expect(tables).toEqual(
      expect.arrayContaining(['clients', 'client_consents', 'audit_log', 'measurements']),
    )
    // The better-auth tables are owner-only and deliberately NOT RLS — if they
    // ever appear here, migration 0006's REVOKE is no longer the whole story.
    expect(tables).not.toContain('users')
    expect(tables).not.toContain('sessions')
  })

  it('forces RLS on every table that enables it', () => {
    const forced = forcedTablesFromMigrations()
    const missing = rlsTablesFromSchema().filter((t) => !forced.has(t))
    expect(
      missing,
      `These tables call .enableRLS() in db/schema.ts but no migration FORCEs it: ` +
        `${missing.join(', ')}.\n` +
        `drizzle-kit does not generate FORCE — append\n` +
        `  ALTER TABLE "<table>" FORCE ROW LEVEL SECURITY;\n` +
        `to the migration that creates each one, by hand, as every migration ` +
        `since 0001 does. Without it the owner connection bypasses the policy.`,
    ).toEqual([])
  })
})
