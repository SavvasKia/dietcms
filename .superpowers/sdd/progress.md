Task 1: complete (commits ed83f54..e92c378, review clean after fixes)
Task 2: complete (commits e92c378..b8da129, review Approved)
  Minor (for final review): missing EOF newline in db/migrations/meta/*.json; schema test lacks FK/PK assertions; db/client.ts neon-serverless Pool vs neon-http driver consistency to document.
Task 3: complete (commits b8da129..51d5267, review Approved)
  Minor (final review): deprecated StackHandler app/routeProps props (documented inline); follow up on Stack v2 migration.
  OPEN ⚠️ (controller): live auth runtime + signup unverified until STACK pck_/ssk_ keys provided.
Task 4: complete (commits 51d5267..4b44bd7, review Approved)
  Minor (final review): ensureTenantForUser check-then-insert race (no unique constraint / tx); dashboard uses email as displayName placeholder.
  OPEN ⚠️ (controller): dashboard/middleware runtime + Neon row creation unverified until STACK keys provided.
Task 6: complete (commits 4b44bd7..b761f5a, review Approved after 1 fix loop — reinstated 'note', shared lib/pii-denylist.ts, hardened scrubber)
Task 7: complete (commits b761f5a..5290f52, review Approved after 1 fix loop — capture-guard test, double-init guard)
PIVOT: auth = Neon Auth API-only (Better Auth, createNeonAuth) NOT Stack Auth. Task 3 needs rework. User confirmed.
Task 3 REWORK: complete (commit 5290f52..77ae7bb, review Approved). Auth now Neon Auth API-only (Better Auth, @neondatabase/auth@0.4.2-beta), proxy.ts, Greek sign-in/up. getCurrentUser signature preserved.
  Important (final review): @neondatabase/auth is BETA — pin <1.0.0, upgrade to stable before go-live (GDPR health app).
  Minor (final): no progressive enhancement on auth forms; confirm Better Auth rate-limit/CSRF before go-live; kysely transitive dep present.
  RESOLVED ⚠️: Tasks 3/4 auth runtime now build-verified (pnpm build green, all routes compile). Live signup against Neon still not exercised headlessly.
Task 8: complete (commits 77ae7bb..f208d21, review Approved — vercel.json fra1, CI pipeline, README, lint fixed to green)
Task 5: complete (commits 5d23d90..0ea51f7, review Approved + 1 strengthening fix). RLS tenant isolation PROVEN (6/6 int tests, FORCE RLS, fail-closed, app.user_id GUC, authenticated_backend role).
  Follow-ups (final review): tenant_members/tenants have NO RLS yet (authenticated_backend can enumerate them) — MUST add before any membership-facing feature; withUser tx-cast footgun (documented); policy 'limit 1' assumes single tenant per user.
ALL 8 FOUNDATION TASKS COMPLETE.
FINAL-REVIEW blockers fixed: commit 0ea51f7..77ee8a2 — B1 (RLS+FORCE on tenants/tenant_members, self-scoped policies) + B2 (unique(user_id) + race-safe transactional bootstrap with orphan cleanup). 12/12 int, 20/20 unit.
Blocker fix re-review: Approved (commit 0ea51f7..77ee8a2) — B1+B2 soundly fixed, no new isolation holes. Minor follow-up: guard winner undefined in ensureTenantForUser race path.
BRANCH MERGE-READY: 8/8 tasks + 2 blockers fixed. Pending: owner Path B sign-off; merge decision.
Foundation MERGED to main (--no-ff). Path B accepted by owner. Branch deleted.

=== MODULE: client-records+GDPR (branch feat/client-records, base ecdd1b2) ===
Task 1: complete (commits ecdd1b2..9df2c07, hardening 38888f9, review Approved after 1 fix loop). clients table, 18 cols, RLS+FORCE verified live (pg_class relforcerowsecurity=true), policy on authenticated_backend. 21/21 unit, 17/17 int.
  Fixed in review: cross-tenant WITH CHECK assertion was a bare toThrow() (passed on ANY error — the tightened /row-level security/i regex initially FAILED, proving it was not testing RLS); Drizzle wraps pg errors in .cause, added errorChain() helper. Also added clientIdA truthiness guards — not.toContain(undefined) passed vacuously when the insert test broke.
  Follow-up (schema-wide, decide at Task 3/4): NO index on any tenant-scoped column repo-wide (only *_pkey + tenant_members_user_id_unique). RLS policy subquery IS indexed via tenant_members_user_id_unique; only the outer tenant_id filter seq-scans. Decide the convention once and fold into each task's own migration — do not bolt on an orphan 0004.
  Follow-up (foundation, merged): tests/integration/rls-isolation.test.ts:74 has the SAME two defects (bare toThrow + noteIdA cross-test dependency). Not fixed here to keep the merged-foundation edit out of this task's commit.
  Minor: lawful_basis and sex are free text with no CHECK/enum — a typo on a GDPR-load-bearing field persists silently. updated_at has no trigger; service layer must set it (Task 2). Unit test uses arrayContaining, so it won't catch an extra PII column (Task 6 tripwire covers that).
Task 2: complete (commits b3d7d49, 50d247d, review fixes 0bacf26, review Approved after 1 fix loop). lib/clients.ts service layer: createClient/getClient/listClients/updateClient/softDeleteClient. callerTenantId takes the live tx (no nested withUser). 30/30 int, 21/21 unit, typecheck+lint clean.
  Implementer deviation ACCEPTED: each test creates its own client instead of guarding a shared createdId — the plan's single id gets soft-deleted mid-suite, incompatible with the added soft-delete/update-after-delete cases. Removes the shared mutable id entirely.
  Fixed in review (1) MASS ASSIGNMENT: create/update spread the caller object into .values()/.set(). Now filtered through NEW_CLIENT_KEYS. Blocks smuggled deletedAt (soft-delete bypassing Task 3's audit hook), lawfulBasis (GDPR legal fact), createdAt backdating. tenantId was already covered by RLS WITH CHECK. `satisfies` catches a typo; NewClientKeysAreComplete fails typecheck if NewClient gains an unlisted field (verified: error TS2344 Type 'false' does not satisfy 'true').
  Fixed in review (2) DECISION — ALL TIMESTAMPS COME FROM THE DB CLOCK. updateClient wrote the app clock while created_at is defaultNow(), so a skewed function host could persist updated_at < created_at. Both now sql`now()` (transaction start). softDeleteClient left updated_at stale; it bumps both. Task 3 audit timestamps inherit this decision — do not re-litigate.
  NOTE the implementer's reported "resurrect a soft-deleted client via deletedAt: null" attack was ALREADY BLOCKED by updateClient's isNull(deletedAt) predicate — the forcing test (whitelist neutered) showed that probe still passing. The live hole was mass assignment on a LIVE client. Lesson: neuter the guard and re-run, or a probe that proves nothing reads as coverage.
  Minor: `pnpm test:int -- clients-rls` does NOT filter (vitest ignores the arg) — the whole integration suite runs. Every remaining task's plan verification step reads as targeted but is not. Harmless; do not chase.
  Minor: callerTenantId is `limit 1` with no where/order, safe only because tenant_members has unique(user_id). The clients RLS policy uses the same limit-1 subquery (db/schema.ts:89) — allowing multi-tenant membership breaks both at once.
  Minor: integration tests are not hermetic (shared Neon dev DB); a hard crash leaves rows since afterAll won't run. Pre-existing.
