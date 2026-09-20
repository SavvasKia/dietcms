import { describe, expect, it } from 'vitest'
import { appointments } from '@/db/schema'
import { APPOINTMENT_STATUSES, BLOCKING_STATUSES } from '@/db/appointment-statuses'
import {
  allMigrationSql,
  migrationCheckLiterals,
  schemaCheckLiterals,
} from '../helpers/migration-sql'

/**
 * Two constraints on `appointments`, guarded for two different reasons.
 *
 * `appointments_status_known` is generated: db/schema.ts builds it from
 * APPOINTMENT_STATUSES, so the only drift worth testing is schema-vs-migration
 * — edit the status list, skip `pnpm db:generate`, and the deployed CHECK still
 * carries the old one. Comparing the rendered SQL back to the constant would be
 * a tautology; the migration on disk is the real second copy.
 *
 * `appointments_no_overlap` is the harder case: drizzle-kit cannot express an
 * EXCLUDE constraint at all, so it was written BY HAND into migration 0010 and
 * NO other gate can see it. `pnpm check:migrations` compares against drizzle's
 * own snapshot, which has no record of it; the schema has no record of it
 * either. Deleting that line from the migration would leave every gate green
 * and silently restore double-booking. Same blind spot as FORCE ROW LEVEL
 * SECURITY, guarded the same way.
 */

const STATUS_CHECK = 'appointments_status_known'
const OVERLAP = 'appointments_no_overlap'

/** The one hand-written EXCLUDE statement, or null. */
function overlapStatement(): string | null {
  const m = allMigrationSql().match(
    new RegExp(`ALTER TABLE[^;]*?"?${OVERLAP}"?\\s+EXCLUDE[^;]*;`, 'is'),
  )
  return m ? m[0] : null
}

describe('appointments_status_known', () => {
  it('db/schema.ts declares it and a migration creates it', () => {
    expect(schemaCheckLiterals(appointments, STATUS_CHECK).length).toBeGreaterThan(0)
    expect(migrationCheckLiterals(STATUS_CHECK).length).toBeGreaterThan(0)
  })

  it('the generated migration matches APPOINTMENT_STATUSES', () => {
    // Red when someone edits db/appointment-statuses.ts and forgets
    // `pnpm db:generate`: the runtime guard would then admit a status the
    // deployed CHECK still rejects, surfacing as a 23514 from Postgres.
    expect(migrationCheckLiterals(STATUS_CHECK).sort()).toEqual([...APPOINTMENT_STATUSES].sort())
  })

  it('schema and migration agree with each other', () => {
    expect(schemaCheckLiterals(appointments, STATUS_CHECK).sort()).toEqual(
      migrationCheckLiterals(STATUS_CHECK).sort(),
    )
  })
})

describe('appointments_no_overlap', () => {
  it('a migration adds the exclusion constraint', () => {
    expect(
      overlapStatement(),
      `No migration adds ${OVERLAP}. drizzle-kit cannot generate an EXCLUDE ` +
        'constraint, so it lives only as hand-written SQL in migration 0010 — if ' +
        'it was dropped, nothing else in this repo would notice and two clients ' +
        'can be booked into the same slot.',
    ).not.toBeNull()
  })

  it('creates the btree_gist extension it depends on', () => {
    // The constraint puts tenant_id (uuid) in a GiST index, which needs
    // btree_gist's operator class. Without the CREATE EXTENSION the ALTER TABLE
    // fails at migrate time — so this assertion is about the migration being
    // APPLICABLE, not merely present.
    expect(allMigrationSql()).toMatch(/CREATE EXTENSION IF NOT EXISTS btree_gist/i)
  })

  it('uses a half-open range, so back-to-back appointments do not collide', () => {
    // '[]' or the default '[)' omitted would make an appointment ending at 10:00
    // conflict with one starting at 10:00 — every consecutive booking rejected.
    expect(overlapStatement()).toContain("tstzrange(starts_at, ends_at, '[)')")
  })

  it('scopes conflicts to one tenant', () => {
    // Without `tenant_id WITH =` the constraint is global: one practice's
    // booking would block another's, and the rejection would disclose that a
    // foreign tenant holds that slot.
    expect(overlapStatement()).toMatch(/tenant_id\s+WITH\s+=/i)
  })

  it('is partial on exactly BLOCKING_STATUSES', () => {
    // [\s\S] rather than the `s` flag: tsconfig targets below es2018.
    const where = overlapStatement()!.match(/WHERE\s*\(([\s\S]*)\)\s*;?\s*$/i)
    expect(where, 'the constraint is not partial — a cancelled appointment would block its slot forever').not.toBeNull()
    const literals = [...where![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(
      literals.sort(),
      'the migration and BLOCKING_STATUSES disagree about which statuses occupy a slot',
    ).toEqual([...BLOCKING_STATUSES].sort())
  })

  it('every blocking status is a real status', () => {
    for (const s of BLOCKING_STATUSES) {
      expect(APPOINTMENT_STATUSES).toContain(s)
    }
  })
})
