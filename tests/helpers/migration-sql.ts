import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core'
import type { PgTable } from 'drizzle-orm/pg-core'

/**
 * Reading a constraint back out of BOTH places it exists: the Drizzle schema
 * and the migration SQL on disk.
 *
 * The drift these support is always schema-vs-MIGRATION. When db/schema.ts
 * builds a CHECK from a TypeScript constant, comparing the rendered SQL back to
 * that constant is a tautology — both sides are the same value and the
 * assertion cannot fail. The migration is the genuine second copy: written at a
 * different time, by a different tool, and the only one a database ever sees.
 *
 * Extracted when the appointment-status CHECK needed exactly what the consent
 * scope CHECK already had.
 */

const MIGRATIONS = join(process.cwd(), 'db', 'migrations')

/** Every .sql migration, in application order. */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/** Concatenated migration SQL, for presence checks that do not care which file. */
export function allMigrationSql(): string {
  return migrationFiles()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n')
}

/**
 * The single-quoted literals of the CHECK that db/schema.ts declares, or throws
 * when the table declares no such constraint.
 */
export function schemaCheckLiterals(table: PgTable, constraint: string): string[] {
  const found = getTableConfig(table).checks.find((c) => c.name === constraint)
  if (!found) throw new Error(`db/schema.ts declares no CHECK named ${constraint}`)
  const sql = new PgDialect().sqlToQuery(found.value).sql
  return [...sql.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/**
 * The single-quoted literals of the LAST migration statement that defines the
 * constraint — last, not first, so a future drop-and-recreate is read
 * correctly. Extending a CHECK is a drop/add, which is exactly why this repo
 * chose a CHECK over a pg enum.
 *
 * Throws rather than returning empty when nothing defines it: an empty result
 * would let an equality assertion pass vacuously against an empty expectation.
 */
export function migrationCheckLiterals(constraint: string): string[] {
  let found: string[] | null = null
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    for (const m of sql.matchAll(
      new RegExp(`CONSTRAINT "?${constraint}"?\\s+CHECK\\s*\\(([^;]*?)\\)\\s*;`, 'gis'),
    )) {
      found = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    }
  }
  if (found === null) {
    throw new Error(
      `no migration in db/migrations adds ${constraint}. db/schema.ts declares it, ` +
        'so it was never generated — run `pnpm db:generate` and commit the result, ' +
        'or the constraint exists only in TypeScript and no database will enforce it.',
    )
  }
  return found
}
