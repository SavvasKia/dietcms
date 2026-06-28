CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "notes_tenant_isolation" ON "notes" AS PERMISSIVE FOR ALL TO "authenticated_backend" USING ("notes"."tenant_id" = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)) WITH CHECK ("notes"."tenant_id" = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1));