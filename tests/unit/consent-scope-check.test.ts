import { describe, expect, it } from 'vitest'
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core'
import { clientConsents } from '@/db/schema'
import { CONSENT_SCOPES } from '@/db/consent-scopes'

/**
 * The CHECK exists so `assertScope` in lib/consents.ts is defence-in-depth
 * rather than the only guard, and so RETIRING a scope has to be a migration
 * instead of an edit to a TypeScript union that silently hides live rows.
 *
 * These are structural assertions only. That Postgres actually rejects an
 * out-of-band scope is behavioural and lives in tests/integration/consents.test.ts.
 */
const checkSql = () => {
  const { checks } = getTableConfig(clientConsents)
  const known = checks.find((c) => c.name === 'client_consents_scope_known')
  if (!known) {
    throw new Error(
      `client_consents has no CHECK named client_consents_scope_known (found: ${
        checks.map((c) => c.name).join(', ') || 'none'
      })`,
    )
  }
  return new PgDialect().sqlToQuery(known.value).sql
}

describe('client_consents scope CHECK', () => {
  it('names the constraint client_consents_scope_known', () => {
    expect(() => checkSql()).not.toThrow()
  })

  it('admits exactly the scopes in CONSENT_SCOPES, with no drift in either direction', () => {
    const sql = checkSql()
    // Both directions matter: a scope missing from the CHECK rejects valid data,
    // and a scope left in the CHECK after retirement keeps accepting dead values.
    const literals = [...sql.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    expect(literals).toEqual([...CONSENT_SCOPES].sort())
  })

})
