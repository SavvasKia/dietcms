CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"dob" date,
	"sex" text,
	"email" text,
	"phone" text,
	"address" text,
	"afm" text,
	"medical_history" text,
	"allergies" text[] DEFAULT '{}'::text[] NOT NULL,
	"goals" text,
	"notes" text,
	"lawful_basis" text DEFAULT 'art_9_2_h_healthcare' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "clients_tenant_isolation" ON "clients" AS PERMISSIVE FOR ALL TO "authenticated_backend" USING ("clients"."tenant_id" = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)) WITH CHECK ("clients"."tenant_id" = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1));