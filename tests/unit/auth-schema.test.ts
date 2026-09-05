import { describe, it, expect } from 'vitest'
import { users, sessions, accounts, verifications } from '@/db/schema'
import { getTableConfig } from 'drizzle-orm/pg-core'

describe('better-auth schema', () => {
  it('users has the core identity columns', () => {
    const cols = getTableConfig(users).columns.map((c) => c.name)
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'name',
        'email',
        'email_verified',
        'image',
        'created_at',
        'updated_at',
      ]),
    )
  })

  it('sessions maps a session to its user', () => {
    const cols = getTableConfig(sessions).columns.map((c) => c.name)
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'user_id',
        'token',
        'expires_at',
        'ip_address',
        'user_agent',
      ]),
    )
  })

  it('accounts holds provider credentials including the hashed password', () => {
    const cols = getTableConfig(accounts).columns.map((c) => c.name)
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'user_id', 'account_id', 'provider_id', 'password']),
    )
  })

  it('verifications holds one-time tokens', () => {
    const cols = getTableConfig(verifications).columns.map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['id', 'identifier', 'value', 'expires_at']))
  })

  it('none of the better-auth tables enable RLS', () => {
    expect(getTableConfig(users).enableRLS).toBe(false)
    expect(getTableConfig(sessions).enableRLS).toBe(false)
    expect(getTableConfig(accounts).enableRLS).toBe(false)
    expect(getTableConfig(verifications).enableRLS).toBe(false)
  })
})
