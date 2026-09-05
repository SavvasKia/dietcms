import { betterAuth } from 'better-auth'
import { nextCookies } from 'better-auth/next-js'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { db } from '@/db/client'
import * as schema from '@/db/schema'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema, usePlural: true }),
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  plugins: [nextCookies()], // must be last — see better-auth's Next.js docs
})
