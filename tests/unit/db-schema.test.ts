import { describe, it, expect } from 'vitest'
import { tenants, tenantMembers } from '@/db/schema'
import { getTableConfig } from 'drizzle-orm/pg-core'

describe('schema', () => {
  it('tenants has tenant identity columns', () => {
    const cols = getTableConfig(tenants).columns.map((c) => c.name)
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'name', 'afm', 'address', 'subscription_state', 'created_at']),
    )
  })
  it('tenant_members maps user to tenant with role', () => {
    const cols = getTableConfig(tenantMembers).columns.map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['user_id', 'tenant_id', 'role']))
  })
})
