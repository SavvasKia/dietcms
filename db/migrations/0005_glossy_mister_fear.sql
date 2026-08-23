CREATE TABLE "client_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"text_version" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client_consents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client_consents" ADD CONSTRAINT "client_consents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_consents_one_active_per_scope" ON "client_consents" USING btree ("client_id","scope") WHERE withdrawn_at is null;--> statement-breakpoint
CREATE POLICY "client_consents_tenant_isolation" ON "client_consents" AS PERMISSIVE FOR ALL TO "authenticated_backend" USING ("client_consents"."tenant_id" = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)) WITH CHECK ("client_consents"."tenant_id" = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1));