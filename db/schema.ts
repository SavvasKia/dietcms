import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  jsonb,
  numeric,
  primaryKey,
  unique,
  uniqueIndex,
  boolean,
} from 'drizzle-orm/pg-core'
import { check, index, pgPolicy } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { CONSENT_SCOPES } from './consent-scopes'

// better-auth owns this schema directly (app-owned, not Neon-managed). Plain
// tables, no RLS: better-auth reads/writes them through the owner pool
// (db/client.ts), never through the tenant-scoped authedDb/withUser path,
// and a tenant relationship doesn't exist yet when these are first touched
// (ensureTenantForUser bootstraps it afterward). authenticated_backend gets
// no grants on these tables — but NOT automatically: the foundation's
// ALTER DEFAULT PRIVILEGES hands authenticated_backend CRUD on every new
// table, so migration 0006 explicitly REVOKEs it here (same pattern as
// audit_log's REVOKE UPDATE, DELETE in migration 0004), or a request-path
// connection would have unrestricted access to password hashes and
// session tokens with no RLS to filter it.
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// INDEX CONVENTION (settled after being deferred through Tasks 1, 3 and 5; the
// rules and their rationale are asserted in tests/unit/index-convention.test.ts):
//   1. every FK referencing column gets a NON-PARTIAL index — Postgres indexes
//      only the referenced side, so an un-indexed child seq-scans on every
//      parent DELETE, and four tables here cascade;
//   2. columns lib/ actually filters on get an index where the table is
//      unbounded. Nothing speculative beyond those two.
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  // Rule 1. Also the lookup better-auth does on every session revocation.
  (t) => [index('sessions_user_id_idx').on(t.userId)],
)

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Rule 1. Also better-auth's credential lookup path on every sign-in.
  (t) => [index('accounts_user_id_idx').on(t.userId)],
)

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

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
    // Rule 1: the PK leads with user_id and the unique is user_id alone, so
    // neither serves a predicate on tenant_id — including tenants' own cascade.
    index('tenant_members_tenant_id_idx').on(t.tenantId),
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
    // Rule 2: listClients filters on tenant_id (injected by the RLS policy below)
    // AND `deleted_at is null`. Partial on purpose — a soft-deleted client is
    // never listed, so indexing those rows would only grow the index. There is no
    // FK on tenant_id, so rule 1 does not apply here.
    index('clients_tenant_id_live_idx')
      .on(t.tenantId)
      .where(sql`deleted_at is null`),
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
    // Rule 2, and the one that actually bites: this is the only monotonically
    // growing table in the schema. tenant_id leads because the RLS policy below
    // puts it in EVERY request-path predicate, so this also serves a tenant-wide
    // read; client_id follows for exportClient's read and eraseClient's
    // anonymization, which filter on both. Not partial: deny rows carry a null
    // client_id and a tenant-wide audit read must still see them.
    index('audit_log_tenant_id_client_id_idx').on(t.tenantId, t.clientId),
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
    // Rule 1. The unique index above is PARTIAL, so it cannot serve clients'
    // ON DELETE CASCADE, which must find withdrawn rows too — and eraseClient
    // deletes that parent on the request path. Also serves exportClient's
    // full-history read, which the partial index likewise cannot.
    index('client_consents_client_id_idx').on(t.clientId),
    // Pairs with assertScope in lib/consents.ts the same way the partial unique
    // index pairs with withdrawConsent's withdraw-all: the runtime guard is then
    // defence-in-depth rather than the only thing standing between a value out of
    // JSON.parse and the table. Built FROM CONSENT_SCOPES, never a hand-copied
    // list — a second copy is exactly the drift this constraint exists to stop.
    // CHECK rather than a pg enum: extending a CHECK is a drop/add, whereas enum
    // value ordering is painful. Retiring a scope is therefore a migration.
    check(
      'client_consents_scope_known',
      sql.raw(`scope in (${CONSENT_SCOPES.map((s) => `'${s}'`).join(', ')})`),
    ),
    pgPolicy('client_consents_tenant_isolation', {
      for: 'all',
      to: 'authenticated_backend',
      using: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
      withCheck: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
    }),
  ],
).enableRLS()

// Anthropometry — the clinical dataset the practice actually records.
// A measurement is a dated OBSERVATION of one client, not a mutable profile:
// correcting a mistyped weight deletes the row and records a new one, which is
// why lib/measurements.ts has no update path and this table has no updated_at.
//
// NO `bmi` COLUMN, deliberately. BMI is weight/height^2 and nothing else; a
// stored copy goes stale the moment either input is corrected, and no query
// filters on it. It is derived by `bmi()` in lib/measurements.ts.
//
// Every metric is NULLABLE — a weigh-in records weight alone far more often
// than a full body-composition workup — but a row with NO metric at all is not
// an observation, which `measurements_not_empty` enforces. `notes` does not
// count: a note about nothing measured belongs on the client.
//
// numeric(mode: 'number') rather than the default string mapping: these are
// arithmetic values (bmi(), trend deltas) and every call site would otherwise
// open with a parseFloat. The magnitudes are far inside the range that mode
// carries exactly, and numeric over real keeps 0.1 kg exact — a float column
// would make two visually identical weights compare unequal.
export const measurements = pgTable(
  'measurements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    // The clinical date, caller-supplied so a past weigh-in can be entered, and
    // defaulted to the DB clock like every other timestamp here. NOT CHECKed
    // against the future: a CHECK may only call IMMUTABLE functions and now()
    // is STABLE. That guard belongs at the route layer.
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull().defaultNow(),
    weightKg: numeric('weight_kg', { precision: 5, scale: 2, mode: 'number' }),
    heightCm: numeric('height_cm', { precision: 5, scale: 1, mode: 'number' }),
    bodyFatPct: numeric('body_fat_pct', { precision: 4, scale: 1, mode: 'number' }),
    waistCm: numeric('waist_cm', { precision: 5, scale: 1, mode: 'number' }),
    hipCm: numeric('hip_cm', { precision: 5, scale: 1, mode: 'number' }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Rule 1 (FK index) and rule 2 in one: every read is "this client's
    // measurements, newest first", and clients' ON DELETE CASCADE must find
    // every row for a client. client_id LEADS, so this also serves the bare
    // client_id lookup the cascade needs — (measured_at, client_id) would
    // satisfy neither.
    index('measurements_client_id_measured_at_idx').on(t.clientId, t.measuredAt),
    // Bounds, not clinical judgment: they reject a transposed digit or a value
    // entered in the wrong unit, and nothing narrower. Pairs with the route
    // layer the way client_consents_scope_known pairs with assertScope.
    check(
      'measurements_weight_kg_range',
      sql`weight_kg is null or (weight_kg > 0 and weight_kg < 1000)`,
    ),
    check(
      'measurements_height_cm_range',
      sql`height_cm is null or (height_cm > 0 and height_cm < 300)`,
    ),
    check(
      'measurements_body_fat_pct_range',
      sql`body_fat_pct is null or (body_fat_pct >= 0 and body_fat_pct <= 100)`,
    ),
    check('measurements_waist_cm_range', sql`waist_cm is null or (waist_cm > 0 and waist_cm < 500)`),
    check('measurements_hip_cm_range', sql`hip_cm is null or (hip_cm > 0 and hip_cm < 500)`),
    // An all-null row is not an observation. Without this, an empty form
    // persists a dated blank line in the history that also counts toward the
    // GDPR export.
    check(
      'measurements_not_empty',
      sql`weight_kg is not null or height_cm is not null or body_fat_pct is not null or waist_cm is not null or hip_cm is not null`,
    ),
    pgPolicy('measurements_tenant_isolation', {
      for: 'all',
      to: 'authenticated_backend',
      using: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
      withCheck: sql`${t.tenantId} = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)`,
    }),
  ],
).enableRLS()
