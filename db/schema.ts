import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  jsonb,
  primaryKey,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
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

export const clients = pgTable(
  'clients',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    dob: date('dob'),
    sex: text('sex'),
    email: text('email'),
    phone: text('phone'),
    address: text('address'),
    afm: text('afm'),
    medicalHistory: text('medical_history'),
    allergies: text('allergies').array().notNull().default(sql`'{}'::text[]`),
    goals: text('goals'),
    notes: text('notes'),
    lawfulBasis: text('lawful_basis').notNull().default('art_9_2_h_healthcare'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    pgPolicy('clients_tenant_isolation', {
      for: 'all',
      to: 'authenticated_backend',
      using: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
      withCheck: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
    }),
  ],
).enableRLS()

// Append-only audit trail. `authenticated_backend` keeps only INSERT + SELECT
// (the migration REVOKEs the UPDATE/DELETE that ALTER DEFAULT PRIVILEGES hands
// out), so the request path physically cannot rewrite history; Task 5's erasure
// anonymizes through the owner path instead.
//
// `client_id` is a deliberate addition to spec §4: erasure has to find the audit
// rows referencing an erased client, and the GDPR coverage tripwire keys off
// client-scoped columns. No FK on purpose — ON DELETE CASCADE would *delete*
// audit rows on erasure (spec says anonymize) and RESTRICT would block erasure.
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    actorUserId: text('actor_user_id').notNull(),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id'),
    clientId: uuid('client_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata'),
  },
  (t) => [
    pgPolicy('audit_log_tenant_isolation', {
      for: 'all',
      to: 'authenticated_backend',
      using: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
      withCheck: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
    }),
  ],
).enableRLS()

// Consent records (spec §4). Withdrawal sets `withdrawn_at` and NEVER deletes:
// the trail of what the client agreed to, and when, is itself the evidence.
// Unlike audit_log this table keeps the full CRUD grant — withdrawal is an
// UPDATE on the request path.
//
// `client_consents_one_active_per_scope` is partial ON PURPOSE: it forbids two
// simultaneously-active rows for one (client_id, scope), while still allowing an
// unlimited history of withdrawn rows so a client can re-consent. Without the
// WHERE predicate it would forbid re-granting after withdrawal.
export const clientConsents = pgTable(
  'client_consents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    textVersion: text('text_version').notNull(),
  },
  (t) => [
    uniqueIndex('client_consents_one_active_per_scope')
      .on(t.clientId, t.scope)
      .where(sql`withdrawn_at is null`),
    pgPolicy('client_consents_tenant_isolation', {
      for: 'all',
      to: 'authenticated_backend',
      using: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
      withCheck: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
    }),
  ],
).enableRLS()
