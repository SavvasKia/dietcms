CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"client_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE UPDATE, DELETE ON "audit_log" FROM "authenticated_backend";--> statement-breakpoint
CREATE POLICY "audit_log_tenant_isolation" ON "audit_log" AS PERMISSIVE FOR ALL TO "authenticated_backend" USING ("audit_log"."tenant_id" = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)) WITH CHECK ("audit_log"."tenant_id" = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1));