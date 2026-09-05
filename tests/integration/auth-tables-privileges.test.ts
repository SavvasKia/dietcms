/**
 * better-auth's users/sessions/accounts/verifications tables have no RLS by
 * design (see db/schema.ts) — they are owner-pool-only. This is a grant-level
 * assertion, not a behavioural one: it catches a future migration silently
 * re-granting privileges to authenticated_backend via ALTER DEFAULT
 * PRIVILEGES (which this repo's foundation configured for every new table),
 * which would otherwise go unnoticed since nothing on the request path
 * currently queries these tables directly.
 */
import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '../../db/client'

describe('better-auth tables have no authenticated_backend grants', () => {
  it.each(['users', 'sessions', 'accounts', 'verifications'])(
    '%s has zero grants to authenticated_backend',
    async (tableName) => {
      const { rows } = await db.execute(sql`
        select privilege_type from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = ${tableName}
          and grantee = 'authenticated_backend'`)
      expect(rows, `expected zero grants on ${tableName}`).toHaveLength(0)
    },
  )
})
