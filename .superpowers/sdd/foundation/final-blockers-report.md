# Final Merge-Blocker Fixes Report

**Date:** 2026-06-28  
**Branch:** main  
**Fixes:** B1 (RLS on tenants/tenant_members) + B2 (race-safe unique tenant bootstrap)

---

## 1. Schema Changes (db/schema.ts)

- Added `unique` import from `drizzle-orm/pg-core`
- `tenants`: added `pgPolicy('tenants_member_isolation', ...)` + `.enableRLS()`
- `tenantMembers`: changed constraints from object `{ pk }` to array `[primaryKey, unique, pgPolicy]` + `.enableRLS()`
  - Added `unique('tenant_members_user_id_unique').on(t.userId)` — required for `onConflictDoNothing({ target })` in race-safe bootstrap
  - Added `pgPolicy('tenant_members_self_isolation', ...)` — users see only their own membership row

---

## 2. lib/tenant.ts — Race-Safe Bootstrap

Rewrote `ensureTenantForUser` to run inside a single `db.transaction`. Pattern:
1. SELECT for existing membership inside transaction
2. INSERT tenant, INSERT membership with `onConflictDoNothing({ target: userId })`
3. If `inserted.length === 0`, lost the race: DELETE orphan tenant, SELECT winner's tenantId

`decideBootstrap` and `getTenantIdForUser` exports unchanged.

---

## 3. Migration Applied

**File:** `db/migrations/0002_breezy_doctor_faustus.sql`

SQL applied (in order):
```sql
ALTER TABLE "tenant_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_members" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_user_id_unique" UNIQUE("user_id");
CREATE POLICY "tenant_members_self_isolation" ON "tenant_members" AS PERMISSIVE FOR ALL TO "authenticated_backend" USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
CREATE POLICY "tenants_member_isolation" ON "tenants" AS PERMISSIVE FOR ALL TO "authenticated_backend" USING (id IN (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true))) WITH CHECK (id IN (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true)));
```

**FORCE ROW LEVEL SECURITY confirmed via pg_class:**
```json
[
  { "relname": "tenant_members", "relrowsecurity": true, "relforcerowsecurity": true },
  { "relname": "tenants",        "relrowsecurity": true, "relforcerowsecurity": true }
]
```

---

## 4. Duplicate user_id Check

Query result before migration: `[]` — no duplicates found. Migration applied cleanly.

---

## 5. Test Results

### pnpm typecheck
```
(exit 0, no errors)
```

### pnpm test (unit)
```
 Test Files  6 passed (6)
      Tests  20 passed (20)
   Start at  22:16:50
   Duration  1.83s
```

### pnpm test:int (integration)
```
 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  22:16:56
   Duration  6.44s
```

All 12 integration tests pass:
- Tests 1–6: existing notes RLS isolation — STILL PASSING (notes policy untouched)
- Tests 7–8: tenant_members RLS (userC sees only own row, not userD's)
- Tests 9–10: tenants RLS (userC sees only own tenant, not userD's)
- Test 11: ensureTenantForUser idempotency — two calls return same tenantId
- Test 12: No duplicate membership after double ensureTenantForUser

---

## 6. Notes Policy Confirmation

Tests 1–6 (notes isolation) continue to pass. The notes `pgPolicy` definition was not modified — only the formatting changed (function parameter `()` with no destructuring, since `tenants` policy doesn't need table column refs in its SQL).
