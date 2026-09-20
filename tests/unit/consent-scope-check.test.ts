import { describe, expect, it } from 'vitest'
import { clientConsents } from '@/db/schema'
import { CONSENT_SCOPES } from '@/db/consent-scopes'
import { migrationCheckLiterals, schemaCheckLiterals } from '../helpers/migration-sql'

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
 *
 * The parsing moved to tests/helpers/migration-sql.ts when the appointment
 * status CHECK needed exactly the same thing.
 */

const CONSTRAINT = 'client_consents_scope_known'

describe('client_consents scope CHECK', () => {
  it('db/schema.ts declares the constraint', () => {
    expect(schemaCheckLiterals(clientConsents, CONSTRAINT).length).toBeGreaterThan(0)
  })

  it('a migration actually creates it', () => {
    expect(migrationCheckLiterals(CONSTRAINT).length).toBeGreaterThan(0)
  })

  it('the generated migration matches CONSENT_SCOPES — no un-generated scope change', () => {
    // Fails when someone edits db/consent-scopes.ts and forgets `pnpm db:generate`:
    // assertScope would then admit a scope the deployed CHECK still rejects, and
    // the first symptom would be a 23514 from production Postgres.
    expect(migrationCheckLiterals(CONSTRAINT).sort()).toEqual([...CONSENT_SCOPES].sort())
  })

  it('schema and migration agree with each other', () => {
    expect(schemaCheckLiterals(clientConsents, CONSTRAINT).sort()).toEqual(
      migrationCheckLiterals(CONSTRAINT).sort(),
    )
  })
})
