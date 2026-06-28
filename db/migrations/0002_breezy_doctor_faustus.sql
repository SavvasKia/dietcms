ALTER TABLE "tenant_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_user_id_unique" UNIQUE("user_id");--> statement-breakpoint
CREATE POLICY "tenant_members_self_isolation" ON "tenant_members" AS PERMISSIVE FOR ALL TO "authenticated_backend" USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "tenants_member_isolation" ON "tenants" AS PERMISSIVE FOR ALL TO "authenticated_backend" USING (id IN (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true))) WITH CHECK (id IN (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true)));