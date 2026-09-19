import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core'
import { clientConsents } from '@/db/schema'
import { CONSENT_SCOPES } from '@/db/consent-scopes'

/**
 * The CHECK exists so `assertScope` in lib/consents.ts is defence-in-depth
 * rather than the only guard, and so RETIRING a scope has to be a migration
 * instead of an edit to a TypeScript union that silently hides live rows.
 *
 * THE ONLY DRIFT WORTH TESTING IS SCHEMA vs MIGRATION. db/schema.ts builds the
 * constraint FROM CONSENT_SCOPES, so comparing the rendered SQL back to
 * CONSENT_SCOPES is a tautology — both sides are the same constant, and the
 * assertion cannot fail. What CAN drift is the migration: add a scope, skip
 * `pnpm db:generate`, and the deployed CHECK still carries the old list. Then
 * assertScope admits the value and Postgres rejects it with a 23514 at runtime.
 * So the comparison below is against the migration SQL on disk — a genuine
 * second copy, written at a different time by a different tool.
 *
 * That Postgres actually rejects an out-of-band scope is behavioural and lives
 * in tests/integration/consents-rls.test.ts (section 5b).
 */

const CONSTRAINT = 'client_consents_scope_known'
const MIGRATIONS = join(process.cwd(), 'db', 'migrations')

/** Literals in the CHECK that db/schema.ts builds. */
function schemaScopes(): string[] {
  const known = getTableConfig(clientConsents).checks.find((c) => c.name === CONSTRAINT)
  if (!known) throw new Error(`db/schema.ts declares no CHECK named ${CONSTRAINT}`)
  const sql = new PgDialect().sqlToQuery(known.value).sql
  return [...sql.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/**
 * Literals in the LAST migration statement that defines the constraint. Last,
 * not first, so a future drop-and-recreate is read correctly — extending a
 * CHECK is a drop/add, which is exactly why this was chosen over a pg enum.
 */
function migrationScopes(): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  let found: string[] | null = null
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    for (const m of sql.matchAll(
      new RegExp(`CONSTRAINT "?${CONSTRAINT}"?\\s+CHECK\\s*\\(([^;]*?)\\)\\s*;`, 'gis'),
    )) {
      found = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    }
  }
  if (found === null) {
    throw new Error(
      `no migration in db/migrations adds ${CONSTRAINT}. db/schema.ts declares it, ` +
        'so it was never generated — run `pnpm db:generate` and commit the result, ' +
        'or the constraint exists only in TypeScript and no database will enforce it.',
    )
  }
  return found
}

describe('client_consents scope CHECK', () => {
  it('db/schema.ts declares the constraint', () => {
    expect(schemaScopes().length).toBeGreaterThan(0)
  })

  it('a migration actually creates it', () => {
    expect(migrationScopes().length).toBeGreaterThan(0)
  })

  it('the generated migration matches CONSENT_SCOPES — no un-generated scope change', () => {
    // Fails when someone edits db/consent-scopes.ts and forgets `pnpm db:generate`:
    // assertScope would then admit a scope the deployed CHECK still rejects, and
    // the first symptom would be a 23514 from production Postgres.
    expect(migrationScopes().sort()).toEqual([...CONSENT_SCOPES].sort())
  })

  it('schema and migration agree with each other', () => {
    expect(schemaScopes().sort()).toEqual(migrationScopes().sort())
  })
})
