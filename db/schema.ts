import { pgTable, uuid, text, timestamp, primaryKey, unique } from 'drizzle-orm/pg-core'
import { pgPolicy } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    afm: text('afm'),
    address: text('address'),
    subscriptionState: text('subscription_state').notNull().default('trial'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy('tenants_member_isolation', {
      for: 'all',
      to: 'authenticated_backend',
      using: sql`id IN (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true))`,
      withCheck: sql`id IN (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true))`,
    }),
  ],
).enableRLS()

export const tenantMembers = pgTable(
  'tenant_members',
  {
    userId: text('user_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('owner'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.tenantId] }),
    unique('tenant_members_user_id_unique').on(t.userId),
    pgPolicy('tenant_members_self_isolation', {
      for: 'all',
      to: 'authenticated_backend',
      using: sql`user_id = current_setting('app.user_id', true)`,
      withCheck: sql`user_id = current_setting('app.user_id', true)`,
    }),
  ],
).enableRLS()

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    body: text('body').notNull(),
  },
  (t) => [
    pgPolicy('notes_tenant_isolation', {
      for: 'all',
      to: 'authenticated_backend',
      using: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
      withCheck: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
    }),
  ],
).enableRLS()
