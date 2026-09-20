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
Task 3: complete (commit 11041dc, review Approved — verified independently). audit_log append-only + audit wired into all 5 client-service paths. 52/52 int, 21/21 unit, typecheck+lint clean.
  VERIFIED LIVE (own probe, not the implementer's report): authenticated_backend grants on audit_log = INSERT, SELECT only (no UPDATE/DELETE); relrowsecurity+relforcerowsecurity true on both audit_log and clients; 0 leftover rows and 0 orphan audit rows after a full suite run.
  Implementer forcing runs (all restored green): re-GRANT UPDATE,DELETE -> 3 fail; NO FORCE RLS -> 1 fail; remove denylist check -> 3 fail; swallow audit INSERT error -> 1 fail; remove listClients audit row -> 2 fail.
  PLAN GAP CLOSED: the plan omitted the listClients audit row that spec §5 requires ("List views are audited as a single view with entity='client', entity_id=null"). Following the plan literally would have shipped an unaudited read path.
  DEVIATION KEPT: audit_log has a client_id column (spec §4 omits it) — Task 5 erasure must find audit rows referencing an erased client, and Task 6's tripwire keys off client-scoped columns. NO FK on client_id, deliberate: CASCADE would delete audit rows on erasure (spec says anonymize), RESTRICT would block erasure.
  BEHAVIOUR CHANGE to Task 2: listClients now THROWS 'no tenant for user' for a membership-less caller (was []), because its audit row is unconditional. Note the resulting inconsistency: getClient/updateClient/softDeleteClient return null/false for such a caller (no row -> no audit -> no throw), listClients throws. Not resolved.
  LEAK FOUND + FIXED mid-task: audit wiring made clients-rls.test.ts orphan dozens of audit_log rows per run (audit_log.tenant_id has no FK, and the request role has no DELETE grant, so only the owner path can reap them). 237 already-accumulated rows reaped. TASKS 4-6 MUST COPY THIS REAP PATTERN in afterAll — it is invisible to all four verification gates.
  Requirement-7 partial: the "audit failure rolls back the mutation" test's second half (no client row persisted) has never been seen to fail — Postgres aborts the tx on its own once the audit INSERT errors, and the test hand-rolls its own withUser, so it guards the test's composition rather than the service's. The errorChain half IS forced (forcing run B2). Closing it would need vi.mock('../../lib/audit') around the real createClient; not built.
  OPEN DECISION (owner): denied-access logging. Read-one/update/soft-delete audit only when a row came back, so a cross-tenant access ATTEMPT leaves no trace. Clinical systems usually want exactly those logged. Wrinkle: a denied attempt has no resolvable tenant from the target row, so it must be attributed to the CALLER's tenant, and a membership-less caller cannot be logged on the request path at all. Decide before Task 5 — export/erase semantics differ for rows about another tenant's clients.
  OPEN DECISION (owner): index convention, deferred from Task 1. Still only *_pkey + tenant_members_user_id_unique repo-wide. audit_log grows monotonically and Task 5 filters it by client_id — that is the first place a seq scan actually bites.
Task 3 post-review fixes (commits 765b638, 99403d9):
  REVERTED the listClients behaviour change. Its justification was false: the throw came out of recordAudit's OWN membership lookup, BEFORE any insert, so the membership-less path produced no audit row either way. The change bought zero audit coverage and only turned Task 2's [] into a 500 for a caller racing ensureTenantForUser's bootstrap. listClients now resolves membership first and returns [] when there is none — consistent with getClient/updateClient/softDeleteClient. Lesson: a comment asserting "fails closed" is not evidence; trace which line actually throws.
  RESOLVED OWNER DECISION — denied-access logging: log a `deny` action, WITHOUT the target id. getClient/updateClient/softDeleteClient write a deny row on the miss branch, attributed to the CALLER's tenant, entity_id and client_id null, metadata {outcome:'denied'}. Rationale: the probed uuid may belong to another tenant, and this tenant's log would then permanently hold a foreign client identifier that Task 5's tenant-scoped erasure can never reach. Trade accepted: we know a denied attempt happened and by whom, not which record was probed. recordDeny skips silently for a membership-less caller (no tenant for WITH CHECK to match) — deliberately NOT a throw, that is the listClients trap again. An unknown uuid is indistinguishable from a cross-tenant probe and logs the same. 58/58 int; forcing run (recordDeny neutered) fails 3 tests. TASK 4's consent-service must wire the same deny logging into its per-client read/write paths.
  VERIFIED: migration 0004 file itself contains FORCE ROW LEVEL SECURITY (line 14) and REVOKE UPDATE, DELETE (line 15) — append-only is reproducible from a fresh db:migrate, not just true of this DB. 0 leftover rows after a full suite run.
  Requirement-7 and the index convention stay logged-not-fixed. Requirement 7's second assertion cannot be forced (Postgres aborts the tx itself; the errorChain half IS forced by run B2). Index is perf on tables with zero rows.
Task 4: complete (commits 193e75d, 0997364, review Approved — verified independently). client_consents + lib/consents.ts (grantConsent/withdrawConsent/activeConsents). 99/99 int, 21/21 unit, typecheck+lint clean.
  VERIFIED LIVE (own probe): partial unique index client_consents_one_active_per_scope on (client_id, scope) WHERE (withdrawn_at IS NULL) — predicate PRESENT, which was the trap: without it the index would forbid re-granting after withdrawal, a worse bug than the one it fixes. Migration 0005 file carries FORCE ROW LEVEL SECURITY (line 12), the FK ON DELETE cascade (line 13) and the index WITH predicate (line 14), so it is reproducible from a fresh db:migrate. relrowsecurity+relforcerowsecurity true. Grants = full CRUD (correct — unlike audit_log, no REVOKE here). 0 leftover rows across all 5 tables after a full suite run.
  THREE PLAN DEFECTS FIXED (all forced red before the fix): (1) grantConsent never checked that the target client belongs to the caller's tenant — the FK is satisfied by ANY existing client and the WITH CHECK only validates tenant_id, so a caller could attach a consent row in their own tenant referencing ANOTHER tenant's client id. (2) withdrawConsent stamped only the latest active row, so an unbalanced double grant left one active forever. (3) activeConsents ran one query per scope and its order-by-granted_at-desc-limit-1 was nondeterministic on ties.
  OWNER DECISION: partial unique index, WITH supersede semantics for grantConsent (resolve client under RLS -> withdraw all active rows for the scope -> insert, one transaction). Rejected alternatives: throwing on duplicate pushes withdraw-then-grant onto every caller; returning the existing row silently discards the new text_version, and re-consent to updated wording is exactly the event GDPR requires on the record. Supersede is audited as ONE `create` row with metadata {scope, superseded:true}, no separate withdraw row.
  DEVIATION ACCEPTED: grantConsent returns Consent | null, not Promise<Consent> as the plan said. Forced — a throw would roll back the deny audit row written in the same transaction. New function, no existing callers.
  >>> TASK 5 HANDOFF CONSTRAINT: reachableClient filters isNull(clients.deletedAt) (lib/consents.ts:71), so a SOFT-DELETED client is unreachable and all three consent functions treat it as denied — returning []/false AND writing a deny audit row. GDPR export/erase MUST NOT read consents through lib/consents.ts, or exporting a soft-deleted client returns no consents and spams deny rows. Query client_consents directly under withUser, or via the owner path.
  Defect 2 is now partly dead code: with the index in place no path — not even the owner connection — can create two active rows, so no black-box test distinguishes withdraw-all from withdraw-latest. Forcing runs F7a/F7b prove it is still load-bearing WITHOUT the index. If a future migration drops the index, withdrawConsent is the only remaining guard — do not remove both.
  Minor: supersede is not double-submit-safe — concurrent grants of one scope leave the loser with a 23505 rollback (no bad data). Route-layer concern.
  Minor: activeConsents filters through CONSENT_SCOPES, so retiring a scope from the union hides existing active rows — that is a migration, not an edit.
  Minor: the DB-clock rule is not directly asserted (only withdrawn_at >= granted_at); a transaction's own now() is not observable from outside. Rests on review plus the `new Date()` sweep — verified clean across lib/ and db/.
  CORRECTION to the Task 2 note: `pnpm exec vitest run --config vitest.integration.config.ts <file>` DOES filter. Only the `pnpm test:int -- <name>` form is ignored. Use the exec form for tight forcing-test loops.
Task 5: complete (commits bd38921, eaba4b3, review Approved — verified independently). lib/gdpr.ts exportClient/eraseClient + 18 integration tests. 117/117 int, 21/21 unit, typecheck+lint clean, 0 leftovers across all 5 tables, no `new Date()` in lib/ or db/.
  PLAN ORDERING REPLACED (spec-grounded, not preference): the plan deleted clinical rows first and anonymized audit_log second, calling the crash window "acceptable for v1". Spec §9 says "on failure, surface and do not mark the client erased" — structurally unsatisfiable once the clinical delete has committed. Corrected order: (1) verify reachability on the request path, (2) anonymize audit_log on the owner connection, (3) delete clinical rows + write the erase row. A crash between 2 and 3 leaves the client PRESENT and the operation RETRYABLE (step 2 is idempotent). Cost: a permanently-failing erasure loses audit DETAIL (entity_id, metadata) for a live client, retaining row/action/at/actor/tenant. Losing detail on a live client is recoverable; a client marked erased with clinical rows on disk is not.
  Steps 1 and 3 are two SEQUENTIAL top-level withUser calls, never nested. Do not merge them for atomicity: the owner UPDATE must land BETWEEN them and there is nowhere else to put it. Two transactions with an idempotent middle step is the trade, forced by Task 3's REVOKE UPDATE.
  OWNER-PATH GUARD ADDED: the plan's `.where(eq(auditLog.clientId, clientId))` relied solely on uuid uniqueness, and the owner connection has BYPASSRLS — the one statement in this codebase with no structural guard. Now scoped by client_id AND the caller's tenant_id, taken from tenant_members (NOT clients.tenant_id — the membership row is the value a caller cannot influence, so the blast radius stays bounded even if the clients policy is later loosened). Forcing run F3 proved it: audit_log has no FK on client_id and its WITH CHECK validates only tenant_id, so another tenant CAN legitimately hold a row referencing this client — without the predicate a BYPASSRLS statement rewrote it. F5 (tenant-only WHERE) anonymized a sibling client's rows.
  Forcing runs, each restored from a byte-identical backup with a clean diff: F1 recordDeny removed -> 5 red; F2 erase row keeps entityId/clientId -> 1 red; F3 tenant_id dropped -> 1 red (cross-tenant row); F4 step-1 verification via the owner connection -> 2 red (calibrated: does NOT destroy victim data — step 3 runs under RLS, matches nothing, the zero-row guard throws; what breaks is the contract); F5 client_id dropped -> 1 red; F6 export metadata -> 1 red.
  DEVIATIONS: erase row keeps the REAL actor, not spec §5's actor=system (staff are not the data subject; accountability for an irreversible delete beats the pseudonym; entity_id/client_id are still null). Soft-deleted clients are reachable by BOTH entry points, deliberately departing from lib/clients.ts and lib/consents.ts — a soft delete is exactly what precedes an erasure request, and hiding it would make the data neither exportable nor erasable. Zero-row delete in step 3 throws (concurrent-erasure race).
  KNOWN RESIDUAL: a FOREIGN tenant's audit_log row referencing an erased client survives, holding a dangling uuid. Tenant-scoped anonymization cannot reach it by design, and audit_log is structurally the only table that can survive this way (a foreign client_consents row goes via ON DELETE CASCADE, which runs below RLS). Accepted over an unbounded blast radius.
  Minor: metadata is nulled wholesale on anonymization, losing PII-free context like {scope}. Minor: no index on audit_log.client_id — the third time the index question defers.
  RECOMMENDED, NOT BUILT — reconciliation sweep: worth building, and it must be PER-TENANT scoped (client_id with no matching clients row IN THE SAME TENANT). That scoping closes both the retry window and the foreign-row residual, and closes the latter CONTINUOUSLY, since a cross-tenant reference is orphaned from the moment it is written, not only after an erasure. A globally scoped sweep looks near-identical but misses a live cross-tenant reference. Owner connection only, never the request path.
  RECOMMENDED, NOT BUILT — invoice/tax retention: policy slot left as a comment in eraseClient's doc block (which columns of a legally retained invoice may stay identifying, and for how long). When the myDATA spike lands, add a THIRD per-table category `retain-with-policy` alongside delete/anonymize so Task 6 can distinguish deliberate retention from silent omission. Never let a retained table default into the anonymize bucket.
  >>> TASK 6 BLOCKER FOUND (my own check, not the implementer's): the plan's coverage test brace-matches a function body and requires the bare table identifier inside it. Against the real lib/gdpr.ts, exportClient does NOT contain the substring `clients` — the clients read is delegated to the reachableClient helper. Verified: exportClient includes clients=false, clientConsents=true, auditLog=true; eraseClient includes all three. The plan's Task 6 test would fail with "clients not referenced in exportClient" — a FALSE NEGATIVE against correct code. Task 6 must resolve identifiers transitively through module-local helpers while still rejecting an import-only reference (the false-green the plan was designed to close).
Task 6: complete (commits 47e1607, dd62567, 1d3a863, review Approved — verified independently). tests/unit/gdpr-coverage.test.ts. 26/26 unit (was 21: tripwire + 4 mechanism tests), 117/117 int, typecheck+lint clean, tree clean. lib/gdpr.ts and db/schema.ts byte-identical to b666f54 — the test mechanism was fixed, not the production code.
  PLAN BLOCKER CONFIRMED AND FIXED: the plan's brace-matched-own-body check reported `clients` absent from exportClient (the read is delegated to the reachableClient helper) — a false RED against fully-covered code. Replaced with a transitive effective-body walk (own body + bodies of all module-local named blocks reached, to a fixpoint, cycle-safe), covering both declaration styles, throwing loudly when an entry point is missing or its effective body is empty.
  IMPLEMENTER FOUND A FALSE GREEN THE BRIEF DID NOT ASK FOR (forcing run D): removing exportClient's auditLog READ while leaving the object key `auditLog: audit` still passed — the audit_log x exportClient cell had no tripwire at all. Fixed with a `(?!\s*:)` property-key exclusion on the table check while leaving the traversal loose. Committed separately (1d3a863). This is the vacuous-pass class again, now caught in FOUR of six tasks.
  Forcing runs A/B/C/D all restored byte-identically (cmp + git diff --exit-code). A added a throwaway client_id table -> red with the guidance message; no db:generate, db/migrations untouched. B stripped a usage leaving the import line AND a type-position reference -> red, so neither imports nor type positions satisfy the check. C stayed green across the helper hop, an inlined read, and the helper rewritten as an arrow const.
  Brittleness (implementer's honest assessment): worst-diagnosed failure is a declaration style the parser does not know (parenless arrow, class/object method, export default, function expression) — the block silently misses the map and the red says "not referenced" when the truth is "not parsed". A brace inside a return-type annotation also breaks brace-matching. False-GREEN surface remains wider than false-red: `{ auditLog }` shorthand, a comment, or a string literal naming the identifier satisfies it. Green here is NOT GDPR assurance; the behavioural proof is tests/integration/gdpr.test.ts.
  retain-with-policy slot: a sibling exemption map consulted inside the entry-point loop. A tax-retained table stays REQUIRED in exportClient (Art 15 still owes it) and is exempted only from eraseClient. No change to tableToIdent, the parser or the traversal.
  FOLLOW-UP (implementer recommendation, agreed): this is a lint rule wearing a test's clothes and will false-red on rename/style churn in the suite devs run on save. Better home is a CI-only policy gate (scripts/check-gdpr-coverage.ts as `pnpm check:gdpr`, or an ESLint rule). Left in tests/unit/ only because that is the only DB-free gate CI runs today.
  DONE 2026-09-19 — the gate moved to scripts/check-gdpr-coverage.mts, run as `pnpm check:gdpr` and wired into CI's test job between lint and `pnpm test`. tests/unit/gdpr-coverage.test.ts now holds ONLY fixture-based mechanism tests importing from that script (8 unit tests, was 5) — the parser stays in the fast suite, the policy verdict does not. Same mechanism, byte-for-byte: parser, traversal, the `(?!\s*:)` property-key exclusion and the entry-point-missing throw were moved unchanged. lib/gdpr.ts and db/schema.ts untouched.
    NEW, not a port — the vacuous-pass guard was rebuilt as a `missing-from-schema` violation. The old version hardcoded `expect(tables).toEqual(arrayContaining([...3 names...]))`; the gate now derives it from REGISTRY, so a registered table that discovery stops reporting (dropped, renamed, or `client_id` removed) reds by name instead of by a duplicated literal.
    RUNNER — SUPERSEDED SAME DAY, kept because the reasoning is the lesson. Originally plain `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/check-gdpr-coverage.mts`, chosen to add zero dependencies, which forced `allowImportingTsExtensions: true` into tsconfig because node's ESM resolver does no extension guessing. The review found that flag could not be scoped: db/schema.ts is dual-use too (app code AND loaded by the gate), so the permission leaked into app code either way. "No new deps" had quietly bought a repo-wide type-system relaxation. Now `tsx scripts/check-gdpr-coverage.ts` with tsx an explicit devDependency (it was already present transitively), no flag anywhere, no `.mts`, no extension spellings. LESSON: price a dependency against what avoiding it costs elsewhere, not against zero.
    Forcing runs, each restored byte-identically (git diff --exit-code clean): F1 throwaway table with a client_id column -> `unregistered`, exit 1; F2 auditLog read deleted from exportClient while `auditLog: audit` property key left in place -> `uncovered`, exit 1 (so the property-key exclusion is STILL load-bearing after the move); F3 client_consents' client_id column renamed -> `missing-from-schema`, exit 1.
    F4 IS THE POINT OF THE CHANGE, and also its cost: with F2's breakage applied, `pnpm test` stays GREEN (12 files, 42 tests) and `pnpm check:gdpr` exits 1. A real coverage regression is now invisible locally and caught only in CI. That is the trade that was agreed — the false-red was landing on whoever renamed a helper — but do not expect the save-loop to catch this class any more.
    Gates after the move: typecheck, lint (eslint does lint the .mts — confirmed via a direct --format json run, not inferred from `eslint .` printing nothing), `pnpm test` 42/42, `pnpm check:gdpr` OK, `next build` green. Integration NOT re-run — unchanged by this and still blocked on a live DB.

=== MODULE COMPLETE: 6/6 tasks. 26/26 unit + 117/117 int, typecheck+lint clean. ===

>>> BRANCH-LEVEL BLOCKER FOUND AT FINAL VERIFICATION (mine, not any implementer's):
.github/workflows/ci.yml runs typecheck, lint, `pnpm test` (unit only) and `pnpm test:e2e`. It does NOT run `pnpm test:int`. So ALL 117 integration tests are local-only and gate nothing: every RLS tenant-isolation proof, the audit_log append-only GRANT assertions, the consent partial-unique-index predicate check, and the GDPR erasure blast-radius test. The entire security and GDPR evidence base for both foundation and this module can regress on main without CI noticing. Root cause is presumably that integration needs a live Neon DB + credentials, which foundation Task 8 did not wire. MUST be decided before merge — either add a CI job with a Neon branch DB (ephemeral branch per run, DATABASE_URL/DATABASE_URL_AUTHENTICATED from secrets) or accept and document that integration is a local-only gate. Do not let this default silently.

POST-MERGE FOLLOW-UPS (Task 4 concern triage, arrived after the module merged):
  LANDED ON MAIN (23c0a92, cherry-picked): AST-based ESLint no-restricted-syntax rule banning `new Date` in lib/ and db/ — the DB-clock decision was recorded but nothing enforced it. Chosen over the proposed source-text grep test: AST means a `new Date` in a comment or string cannot false-positive, an unusual call position cannot slip past, it reports the offending line, and it already runs in CI via pnpm lint. A grep test would have been the THIRD lint rule wearing a test's clothes here. Scoped to lib/ and db/; tests legitimately construct Dates. Forced on main: injecting new Date() into lib/consents.ts fires the rule, restored clean. Also added `test:int:file` — `pnpm test:int -- <name>` silently does not filter (vitest ignores the arg).
  MY PLACEMENT ERROR, FIXED: both of the above were first committed to chore/ci-integration-gate, which is blocked behind Neon test secrets that do not exist — so a secrets-INDEPENDENT enforcement mechanism was stranded behind a secrets gate and could not reach main. Cherry-picked to main; the CI branch rebased and the duplicate dropped. Lesson: do not park secrets-independent work on a secrets-gated branch.
  MERGED (this entry said "OPEN, NOT MERGED" until 2026-09-19; corrected after checking — all three commits are ancestors of origin/main, the branch ref is simply gone) — fix/consent-grant-race (9513c6d, 30f4f69, 1d22a3f), 119/119 int + 26/26 unit + typecheck + lint clean, 0 leftovers. grantConsent resolves the client FOR UPDATE (opt-in via reachableClient's `lock` option, so read paths stay lock-free). Fixes the double-submit 23505: supersede is withdraw-then-insert, so two concurrent grants of one (client_id, scope) can both see zero active rows, both insert, and the loser trips the unique index.
    >>> THE LOCK-MATRIX FINDING, worth keeping: the obvious lock test is VACUOUS. A consent INSERT takes FOR KEY SHARE on the parent client row (the FK protects the key), and FOR KEY SHARE conflicts with FOR UPDATE — so a competing FOR UPDATE holder blocks the grant EVEN WITH THE FIX REVERTED. The discriminating holder is FOR NO KEY UPDATE: conflicts with FOR UPDATE, compatible with FOR KEY SHARE. The same matrix explains why the FK does not already prevent the race — two FOR KEY SHARE holders are compatible with each other. Forced both ways: fix absent -> RED; applied -> GREEN; `{lock:true}` wrongly added to activeConsents -> RED on a latency assertion; reverted -> GREEN.
    Rejected there: racing two real grants as the gate (collision depends on how ~5 round trips interleave; passed with the fix absent, so deleted rather than shipped) and ON CONFLICT ... DO UPDATE (race-free in one statement, but discards the history row the supersede decision deliberately chose).
    This is the FIFTH vacuous-test catch in this module (Tasks 1, 2, 4, 6, and this). Every one was found only by breaking the guard and re-running. Treat "the test passes" as meaningless until it has been seen to fail.
  STILL OPEN (owner decision): CHECK (scope in (...)) on client_consents.scope. Would make the runtime assertScope defense-in-depth rather than the sole guard — the same pairing shape as the unique index with withdraw-all — and forces scope RETIREMENT to be an explicit migration instead of a union edit that silently hides live rows. CHECK preferred over a pg enum: extending a CHECK is a drop/add, enum value ordering is painful. Schema change + migration.

>>> CI HAD NEVER RUN AT ALL — found while pushing the Task 4 concern-5 fix, fixed on main (1df9ba6, c3caa25, 5a2b263). The entries above assume CI runs typecheck, lint, `pnpm test` and `pnpm test:e2e`, and that only the integration suite was ungated. It was worse: EVERY run since the repo's first push died in ~13s at `pnpm/action-setup@v4` with "No pnpm version is specified" — no check has ever executed on any push, including both module merges. Three defects stacked behind each other, each only visible once the previous was fixed:
  1. No pnpm version to install: neither the workflow pinned `version:` nor package.json declared `packageManager`. Fixed by pinning `packageManager: pnpm@11.9.0` (the local version). Also dropped the dead `pnpm.onlyBuiltDependencies` block from package.json — pnpm 11 ignores it, warns on every command, and the setting already lives in pnpm-workspace.yaml as `allowBuilds`.
  2. `node-version: 20` vs pnpm 11's requirement of Node >= 22.13. Bumped the workflow to 22 and .nvmrc with it (it said 20 while local dev has always run 22.22.0). GitHub is deprecating Node 20 on runners anyway.
  3. `ERR_PNPM_IGNORED_BUILDS` for sharp and unrs-resolver — native binaries pnpm 11 refuses to build unless declared. Invisible locally, where an existing node_modules already had them approved. Added to `allowBuilds`.
  FIRST GREEN RUN: 32672462930, 1m15s, every step verified as `success` — install, typecheck, lint, `pnpm test` (26), playwright install, `pnpm test:e2e`. The local four gates and CI now agree for the first time.
  CONSEQUENCE FOR THE CI-GATE DECISION: `chore/ci-integration-gate` is still correctly blocked on the Neon secrets, but note its trigger is `on: [push, pull_request]` — PUSHING that branch (not only merging it) will run the integration job and go red until TEST_DATABASE_URL / TEST_DATABASE_URL_AUTHENTICATED exist. It also needs rebasing onto these three CI fixes, or it will fail at pnpm setup exactly as main did and the secrets assertion will never even be reached.

=== better-auth migration (off @neondatabase/auth 0.4.2-beta) ===
Complete. Replaced the Neon-managed auth wrapper with plain better-auth@1.7.2
+ @better-auth/drizzle-adapter@1.7.2. App now owns users/sessions/accounts/
verifications directly (migration 0006) — plain tables, no RLS, no grants to
authenticated_backend, owner-pool only (db/client.ts). getCurrentUser's
{id,email}|null contract unchanged; ensureTenantForUser and the dashboard
needed zero edits. Sign-in/up actions moved from the wrapper's {error} return
shape to better-auth's real auth.api.signInEmail/signUpEmail, which throw
APIError instead — both now try/catch around the call with redirect() kept
outside the catch. proxy.ts simplified to better-auth's documented Next-16
pattern (getSessionCookie optimistic check; no auth.middleware() equivalent
exists in plain better-auth). PENDING (user, not done here): run
`pnpm db:migrate` against the real Neon dev DB (needs live DATABASE_URL, not
available in the planning/implementation sandbox); set BETTER_AUTH_SECRET +
BETTER_AUTH_URL in Vercel env for preview/production before next deploy.
  POST-MERGE FIX (final whole-branch review caught it, not any per-task
  review): migration 0006 was missing a REVOKE for authenticated_backend on
  the four new tables. This repo's foundation set up ALTER DEFAULT
  PRIVILEGES so that role gets CRUD on every NEW table automatically
  (already worked around once for audit_log in migration 0004) — without
  the same fix here, applying 0006 would have handed the tenant-scoped
  request role unrestricted, un-RLS'd access to password hashes and
  session tokens. Fixed before merge: REVOKE ALL appended to 0006, the
  schema.ts comment corrected to explain why, and an integration test
  added (tests/integration/auth-tables-privileges.test.ts) asserting zero
  grants — mirrors audit-append-only.test.ts's grant-check pattern. NOT
  yet verified against a live DB (same sandbox constraint as db:migrate
  itself) — run `pnpm test:int` after applying 0006 to confirm.
  Full detail (per-task ledger, rulings, fix-wave verification) preserved
  under .superpowers/sdd/2026-09-05-better-auth-migration/ — tracked in
  git, not deleted, matching this file's own convention.

>>> CI-GATE FOLLOW-UP: the `chore/ci-integration-gate` branch referenced
above never actually existed in this repo (checked git branch -a and git
ls-remote against origin — only main). Built fresh instead of resumed, on
branch ci/integration-test-gate: a new `integration` job in
.github/workflows/ci.yml using Neon's official create-branch-action/
delete-branch-action to fork a throwaway branch per run from a dedicated
`ci-base` Neon branch (not production — schema/roles only, no real data),
call the create action a second time with the same branch_name + role:
authenticated_backend to get a second connection string (documented,
idempotent-by-name pattern — does not create a duplicate branch), run
pnpm db:migrate then pnpm test:int against the two URLs, and always
delete the throwaway branch after. Requires the user to: (1) create
`ci-base` in the Neon console (fork from dev — it already has
authenticated_backend and its grants, which no migration in this repo
creates from scratch), (2) create a Neon API key, (3) add repo secret
NEON_API_KEY + repo variable NEON_PROJECT_ID. Will not go green until
those three steps are done — cannot be verified from this sandbox.

=== 2026-09-19 session: three deferred decisions closed, then reviewed ===
Commits 10bb1f4, 81c6b13, 9786d8f, 6870a3e. All DB-free gates green:
typecheck, lint, 54/54 unit, check:gdpr, check:migrations, next build.
NOT run: integration. Migrations 0007 and 0008 are UNAPPLIED, and the new
DB-level tests have therefore never executed. Everything below that says
"verified" means verified without a database unless it names one.

STALE ENTRY CORRECTED: fix/consent-grant-race was logged above as "OPEN,
NOT MERGED". All three commits (9513c6d, 30f4f69, 1d22a3f) are ancestors of
origin/main — only the branch ref is gone. Check reachability, not refs.

CI SECRETS GATE — decided FAIL CLOSED, reversing this session's own first
answer. The first version warned and skipped when NEON_API_KEY /
NEON_PROJECT_ID were absent, so that pushing main would not go red. The
altitude review named that for what it was: permanently normalising "the
integration suite never runs", which is the failure this file already
records once ("CI HAD NEVER RUN AT ALL"), except by design instead of by
accident. It now fails with a message naming the three setup steps.
  CONSEQUENCE, ACCEPTED: main is red until the Neon setup exists. Convenience
  for whoever is pushing is not a reason to weaken the evidence base.
  EXCEPTION, from the correctness review: fork PRs and Dependabot cannot see
  secrets BY DESIGN, so a hard fail there reds a contributor with an
  instruction they have no permission to follow. Those are skipped by a job
  `if:`; every push to this repo still runs it.
  No preflight job: `secrets` really is unreadable from a job-level `if:`
  (only github/needs/vars/inputs), but a whole runner billed at 1-minute
  granularity, on the critical path of every push, is the wrong price for
  testing two variables. It is the first step of the job it guards.

CONSENT SCOPE CHECK (migration 0007) — `client_consents_scope_known`, built
FROM CONSENT_SCOPES via sql.raw, never a copied list. assertScope becomes
defence-in-depth; retiring a scope becomes a migration. CHECK over a pg enum
because extending a CHECK is a drop/add while enum value ordering is not.
  CONSENT_SCOPES moved to db/consent-scopes.ts, a zero-import leaf, so
  db/schema.ts can build the constraint without the cycle that importing
  lib/consents.ts would create (lib/consents.ts -> db/authed-client ->
  db/schema.ts). lib/consents.ts re-exports it; no caller changed. Named
  re-export kept over `export *` deliberately: `export *` would silently
  widen this module's public API if the leaf ever grows.
  >>> THE TEST THAT COULD NOT FAIL. The first version asserted the rendered
  CHECK's literals equalled CONSENT_SCOPES — but db/schema.ts BUILDS that
  CHECK from CONSENT_SCOPES, so both sides were one constant. The reviewer
  forced it: adding a scope without regenerating left typecheck, lint, the
  unit suite and check:gdpr all green, while production Postgres would throw
  23514 against migration 0007's old four literals. It now parses the
  migration SQL on disk — a real second copy, written by a different tool at
  a different time — and reds on exactly that. SIXTH vacuous-test catch in
  this repo. A test comparing a value to itself reads exactly like a test.

INDEX CONVENTION (migration 0008) — settled after deferring through Tasks 1,
3 and 5. Two rules, nothing speculative:
  1. every FK referencing column gets a NON-PARTIAL index. Postgres indexes
     only the referenced side, so an un-indexed child seq-scans on every
     parent DELETE, and four tables cascade. Found four: sessions.user_id,
     accounts.user_id, tenant_members.tenant_id, client_consents.client_id —
     that last hidden behind a PARTIAL unique index, which cannot serve a
     cascade because a cascade must find withdrawn rows too.
  2. columns lib/ actually filters on, where the table is unbounded:
     audit_log(tenant_id, client_id), tenant_id leading because RLS puts it
     in every request-path predicate; and a partial clients(tenant_id) WHERE
     deleted_at is null for listClients.
  Rule 1 is derived from schema metadata, so a future table is caught with no
  list to extend — forced with a table carrying an unindexed FK, red by name.
  Rule 2 is a hand-maintained list and should stay one: "what does lib/
  filter on" is not recoverable from the schema, and auto-deriving it would
  mean a second bespoke parser. Each entry names its query.
  REVIEW FIX: covers() read only table-level primaryKeys/uniqueConstraints,
  but drizzle reports column-level .primaryKey()/.unique() on the COLUMN
  (users.id and sessions.token appear nowhere else). A future
  `userId: text('user_id').primaryKey().references(...)` would have been
  called uncovered and the message would have demanded a duplicate index.
  STILL NOT PROVEN: no EXPLAIN anywhere. These indexes are justified by
  reading predicates, not by observed plans, and the tables have ~zero rows.

GDPR GATE — now an AST check. Moving it out of the save-loop suite fixed
WHEN it runs; the review pointed out the mechanism was still regex plus
brace counting, hand-deriving what a parser does — and that this repo had
already made that exact call once, choosing AST for the `new Date` rule, for
the same reason. Rewritten on the TypeScript compiler API. Closes gaps in
BOTH directions the old version documented but could not fix: declaration
styles it silently dropped (expression-bodied and parenless arrows, a brace
inside a return-type annotation) surfaced as "not referenced" when the truth
was "not parsed"; and comments, string literals and `{ shorthand }`
properties counted as reads. Each has a fixture test.
  STILL BLIND to a read reached through a helper in ANOTHER file — the block
  map is module-local by construction. That produces a false RED, and the
  message says so. Green here is still not GDPR assurance; the behavioural
  proof is tests/integration/gdpr.test.ts.
  NOT an ESLint rule: it needs getTableConfig on a runtime-imported
  db/schema.ts (drizzle metadata is invisible to static analysis) and yields
  one whole-repo verdict, not a per-file diagnostic.
  THE COST OF THE SPLIT, unchanged: with a real read deleted, `pnpm test`
  stays green and only `pnpm check:gdpr` reds. This class is now caught in CI
  only. That was the trade — the false-red was landing on whoever renamed a
  helper — but do not expect the save-loop to catch it.

NEW GATE — `pnpm check:migrations` (scripts/check-migrations.ts). Runs
drizzle-kit generate and fails if anything is produced: db/schema.ts
declaring a table, index or constraint that no migration creates passes
every other DB-free gate and reaches no database. The general form of the
scope-drift bug above, covering all six new indexes too, none of which had
their own assertion. No credentials needed, so it runs in the always-on job.
  Its own first version was wrong in the same family: it deleted generated
  files but left meta/_journal.json appended, because generation MODIFIES
  that file rather than creating one. The forcing run caught it. It now
  restores contents, not just file presence, and was re-forced on both paths.

REVIEW FINDING WORTH REMEMBERING: tsconfig excluded scripts/ from typecheck,
with a comment describing a setup two commits out of date. scripts/ was only
checked incidentally, through the test that imports the gate — a second
script would have shipped unchecked, since tsx strips types without checking
them. Forced with a deliberately ill-typed probe file. Comments justifying a
config exclusion decay silently; the exclusion outlives the reason.

STILL OPEN / BLOCKED ON CREDENTIALS (unchanged by this session):
  - `pnpm db:migrate` against the Neon dev DB: 0006, 0007, 0008 unapplied.
  - `pnpm test:int` afterwards — auth-tables-privileges.test.ts (the 0006
    REVOKE) and consents-rls.test.ts section 5b (the 0007 CHECK) have never
    executed anywhere.
  - BETTER_AUTH_SECRET + BETTER_AUTH_URL in Vercel for preview/production.
  - Neon `ci-base` branch + API key + NEON_API_KEY / NEON_PROJECT_ID.
  - PUSHED 2026-09-19 (da4e7eb..ec733d5, 23 commits), owner decision, with
    the red CI accepted knowingly. Expect the integration job to FAIL until
    the Neon setup above exists; its message names the three steps. The test
    job (typecheck, lint, check:gdpr, check:migrations, unit, e2e) should be
    green — if it is not, that is a real regression, not the known gap.

=== 2026-09-20: measurements — first clinical domain table (f7d3ee0) ===
Feature audit first: the backend was complete (clients, consents, audit,
GDPR) and the PRODUCT was not. app/ holds sign-in, sign-up and a one-line
dashboard; not one of the 11 service functions is reachable from a browser.
Ordering chosen: domain schema BEFORE UI, so client screens are not built
twice. This is increment 1 of that.

MEASUREMENTS (migration 0009) — anthropometry, client-scoped, RLS+FORCE,
FK cascade. Decisions worth keeping:
  NO bmi COLUMN. It is weight/height^2 and nothing else; a stored copy goes
  stale the moment either input is corrected and no query filters on it.
  Derived by bmi() in lib/measurements.ts, which returns NULL rather than
  Infinity/NaN for a non-positive height — it is called on UNSAVED form
  input too, where the CHECKs have not yet had a say.
  numeric(mode:'number'), not the drizzle default: the default maps numeric
  to a STRING, so every call site would open with a parseFloat and bmi()
  would silently produce NaN. Asserted in the integration test, because
  nothing else pins that config.
  measurements_not_empty: a row with no metric is not an observation.
  `notes` deliberately does not satisfy it — a note about nothing measured
  belongs on the client.
  HARD delete, unlike clients. The only reason to remove an observation is
  that it was mistyped, and a soft-deleted typo is a row every future reader
  must filter forever. Consents are the opposite case (the history IS the
  evidence) and stay immortal. The divergence is deliberate; the audit row
  survives either way.
  measured_at is cast in SQL (`${iso}::timestamptz`), not `new Date(...)`:
  the DB-clock lint rule bans that constructor in lib/, and Postgres
  validates the literal — a malformed instant is a 22007 at insert instead
  of an Invalid Date persisted as NULL.

>>> NEW GATE, and the real find of this session: tests/unit/force-rls.test.ts.
`.enableRLS()` emits ENABLE ROW LEVEL SECURITY and NOTHING ELSE — drizzle-kit
has no concept of FORCE — so `ALTER TABLE x FORCE ROW LEVEL SECURITY` has
been appended BY HAND to every migration since 0001. check:migrations cannot
see its absence, because FORCE is not part of the snapshot drizzle diffs.
Migration 0009 as generated was missing it and every gate was green. Without
FORCE the table OWNER is exempt from its own policies — and the owner
connection is what runs migrations and eraseClient's audit anonymization, so
one owner-path query reads across every tenant. The test takes the RLS flag
from schema metadata and the FORCE statements from the SQL on disk: two real
copies, which is the lesson from the tautological scope test.

REFACTOR: lib/client-access.ts. reachableClient / callerTenantId /
callerTenantIdOrNull / recordDeny were about to exist in FOUR copies;
clients.ts and consents.ts moved onto it, and recordDeny now takes the
`entity` explicitly so a refused measurement is distinguishable from a
refused client in the audit trail. lib/gdpr.ts deliberately keeps its own
copies, for two reasons that agree: its reachableClient must find
SOFT-DELETED clients (a soft delete is what precedes an erasure request),
and scripts/check-gdpr-coverage.ts only follows helpers declared INSIDE
lib/gdpr.ts — moving that read out would red the gate against correct code.

FORCING RUNS (all restored byte-identically):
  - check:gdpr red on the unregistered table, then again on the uncovered
    one. >>> THE FIRST ATTEMPT WAS INVALID: it removed `.from(measurements)`
    but left `.where(eq(measurements.clientId, ...))`, so the identifier was
    still read as a value and the gate stayed green — CORRECTLY. A forcing
    run that does not go red is a claim about the forcing run first.
  - index convention rule 1 red by name when the FK index was removed; the
    rule is derived from metadata, so it caught a table written after it.
  - force-rls red on `measurements` before the FORCE line was added by hand.
  - check:migrations red on the schema change before 0009 was generated.

NEVER EXECUTED (same blocker as everything below): migration 0009 is
UNAPPLIED, so tests/integration/measurements-rls.test.ts has never run —
including its DB-level section, which goes AROUND the service on purpose to
prove the CHECKs hold for a caller that does not come through
lib/measurements.ts. The clients.ts/consents.ts move onto client-access.ts
is covered only by typecheck and lint here; its behavioural proof is the
integration suite that needs the same missing database. One existing
assertion was updated, not just extended: the export audit metadata shape
now carries `measurements`.

STILL NOT BUILT (feature backlog, in the order I would take it):
  1. Remaining domain schema: appointments, meal plans, documents.
  2. The whole delivery layer — no route, server action or screen reaches
     any service. A dietitian still cannot add a client.
  3. GDPR Art 15/20 DELIVERY: exportClient returns a TS object; nothing
     serialises it to a portable file or hands it to the data subject, and
     there is no erasure REQUEST path.
  4. Consent text corpus: text_version is a free string and nothing defines
     or renders the wording it versions.
  5. The `notes` table is still an orphan — tenant-scoped, no client_id, no
     service, used only as a fixture by rls-isolation.test.ts. Either drop
     it or give it a client_id and GDPR coverage. It is neither today, and
     the coverage tripwire skips it because it is not client-scoped.
