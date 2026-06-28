import { drizzle } from 'drizzle-orm/neon-serverless'
import { Pool } from '@neondatabase/serverless'
import { sql } from 'drizzle-orm'
import * as schema from './schema'

// Pooled (WebSocket) driver — REQUIRED: the HTTP driver is stateless and cannot
// hold SET LOCAL across statements. This connects as the unprivileged
// authenticated_backend role, so RLS applies.
const authedPool = new Pool({ connectionString: process.env.DATABASE_URL_AUTHENTICATED! })
export const authedDb = drizzle(authedPool, { schema })

// Run `fn` inside a transaction where app.user_id is set to the current user, so
// RLS policies (current_setting('app.user_id')) see them. set_config(..., true)
// = transaction-local. Fails closed: if userId is empty, policies match nothing.
export async function withUser<T>(userId: string, fn: (tx: typeof authedDb) => Promise<T>): Promise<T> {
  return authedDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
    return fn(tx as unknown as typeof authedDb)
  })
}
