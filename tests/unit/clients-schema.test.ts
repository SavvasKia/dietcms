import { describe, it, expect } from 'vitest'
import { clients } from '@/db/schema'
import { getTableConfig } from 'drizzle-orm/pg-core'

describe('clients schema', () => {
  it('has the required client columns', () => {
    const cols = getTableConfig(clients).columns.map((c) => c.name)
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'tenant_id', 'first_name', 'last_name', 'dob', 'sex',
        'email', 'phone', 'address', 'afm', 'medical_history', 'allergies',
        'goals', 'notes', 'lawful_basis', 'created_at', 'updated_at', 'deleted_at',
      ]),
    )
  })
})
