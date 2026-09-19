import { describe, expect, it } from 'vitest'
import { allTables, type TableConfig } from '@/db/introspect'
import * as schema from '@/db/schema'

/**
 * THE INDEX CONVENTION, settled after being deferred through Tasks 1, 3 and 5.
 *
 * Two rules, and nothing speculative beyond them:
 *
 *  1. Every FOREIGN KEY referencing column is covered by a non-partial index.
 *     Postgres indexes the REFERENCED side automatically and the referencing
 *     side never — so an un-indexed child makes every parent DELETE or key
 *     UPDATE seq-scan the child. This repo cascades on delete in four places
 *     (sessions, accounts, tenant_members, client_consents) and `eraseClient`
 *     deletes a parent row on the request path, so it is a live cost, not a
 *     projection. This rule is checked GENERICALLY: a future table gets caught
 *     without anyone remembering to extend a list.
 *
 *  2. Columns that `lib/` actually filters on get an index where the table is
 *     UNBOUNDED. Those cannot be derived from the schema, so they are named
 *     below with the query that justifies each one. Nothing is indexed on the
 *     strength of "might be queried later".
 *
 * A PARTIAL index does not satisfy rule 1: the planner cannot use it for the
 * cascade, which must find every child row including the ones the predicate
 * excludes. `client_consents_one_active_per_scope` is partial, which is exactly
 * why client_consents still needs a plain index on client_id.
 */

type Cover = { cols: string[]; partial: boolean }

/** Every structure that can serve as an index, leading columns first. */
function covers(cfg: TableConfig): Cover[] {
  return [
    ...cfg.indexes.map((i) => ({
      cols: i.config.columns.map((c) => (c as { name?: string }).name ?? ''),
      partial: i.config.where !== undefined,
    })),
    ...cfg.primaryKeys.map((p) => ({ cols: p.columns.map((c) => c.name), partial: false })),
    ...cfg.uniqueConstraints.map((u) => ({ cols: u.columns.map((c) => c.name), partial: false })),
  ]
}

/**
 * A btree index serves a predicate on `wanted` only if they are its LEADING
 * columns. `allowPartial` is the difference between the two rules: rule 1 must
 * reject a partial index (a cascade has to find every child row, including the
 * ones the predicate excludes), rule 2 accepts one because it is matching a
 * specific query — and the clients index is deliberately partial.
 */
const isCoveredBy = (c: Cover, wanted: string[], allowPartial = false) =>
  (allowPartial || !c.partial) && wanted.every((col, i) => c.cols[i] === col)

const tables = allTables(schema)

describe('index convention', () => {
  it('discovers the schema tables (guards a vacuous pass below)', () => {
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['clients', 'client_consents', 'audit_log', 'sessions', 'accounts']),
    )
  })

  it('rule 1: every foreign key referencing column has a non-partial index', () => {
    const uncovered: string[] = []
    for (const cfg of tables) {
      const available = covers(cfg)
      for (const fk of cfg.foreignKeys) {
        const cols = fk.reference().columns.map((c) => c.name)
        if (!available.some((c) => isCoveredBy(c, cols))) {
          uncovered.push(`${cfg.name}(${cols.join(', ')})`)
        }
      }
    }
    expect(
      uncovered,
      'Postgres does not index the referencing side of a foreign key. Without one,\n' +
        'every DELETE or key UPDATE on the parent seq-scans this table — and this repo\n' +
        'cascades on delete. Add `index(...).on(...)` for each column listed, or, if the\n' +
        'table is genuinely write-only and tiny, record that decision here rather than\n' +
        'deleting the assertion. A PARTIAL index does not count: a cascade has to find\n' +
        'every child row, including the ones the predicate excludes.',
    ).toEqual([])
  })

  // Rule 2. Each entry names the query that pays for it.
  const queryDriven: Array<{ table: string; cols: string[]; why: string }> = [
    {
      table: 'audit_log',
      cols: ['tenant_id', 'client_id'],
      why: 'the only monotonically growing table: exportClient reads it by client_id under RLS (which adds tenant_id), and eraseClient anonymizes by both',
    },
    {
      table: 'clients',
      cols: ['tenant_id'],
      why: 'listClients filters tenant_id (via RLS) + deleted_at is null; without it a list seq-scans every tenant’s clients',
    },
  ]

  it.each(queryDriven)('rule 2: $table($cols) is indexed — $why', ({ table, cols }) => {
    const cfg = tables.find((t) => t.name === table)
    expect(cfg, `table ${table} not found in db/schema.ts`).toBeDefined()
    expect(covers(cfg!).some((c) => isCoveredBy(c, cols, true))).toBe(true)
  })
})
