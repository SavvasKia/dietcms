import { getTableConfig } from 'drizzle-orm/pg-core'

/**
 * Schema introspection shared by the checks that reason ABOUT the schema rather
 * than query it: the GDPR coverage gate (scripts/check-gdpr-coverage.ts) and the
 * index convention (tests/unit/index-convention.test.ts).
 *
 * It exists so "how do you tell a Drizzle table export from any other export"
 * is answered in ONE place. Both callers previously carried their own copy of
 * the try/catch-around-getTableConfig idiom, so a change in what drizzle throws
 * for a non-table would have had to be found twice.
 */
export type TableConfig = ReturnType<typeof getTableConfig>

/**
 * Every Drizzle table exported by a schema module, in export order.
 *
 * `getTableConfig` throws for anything that is not a table, which is the only
 * available discriminator — there is no public predicate — so a throw means
 * "not a table" and is skipped rather than propagated. Callers that need a
 * non-empty result must assert it: an empty list would otherwise satisfy every
 * downstream loop vacuously.
 */
export function allTables(schema: Record<string, unknown>): TableConfig[] {
  const tables: TableConfig[] = []
  for (const value of Object.values(schema)) {
    try {
      tables.push(getTableConfig(value as never))
    } catch {
      continue // not a drizzle table
    }
  }
  return tables
}
