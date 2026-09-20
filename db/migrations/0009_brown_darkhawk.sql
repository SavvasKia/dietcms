CREATE TABLE "measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"weight_kg" numeric(5, 2),
	"height_cm" numeric(5, 1),
	"body_fat_pct" numeric(4, 1),
	"waist_cm" numeric(5, 1),
	"hip_cm" numeric(5, 1),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "measurements_weight_kg_range" CHECK (weight_kg is null or (weight_kg > 0 and weight_kg < 1000)),
	CONSTRAINT "measurements_height_cm_range" CHECK (height_cm is null or (height_cm > 0 and height_cm < 300)),
	CONSTRAINT "measurements_body_fat_pct_range" CHECK (body_fat_pct is null or (body_fat_pct >= 0 and body_fat_pct <= 100)),
	CONSTRAINT "measurements_waist_cm_range" CHECK (waist_cm is null or (waist_cm > 0 and waist_cm < 500)),
	CONSTRAINT "measurements_hip_cm_range" CHECK (hip_cm is null or (hip_cm > 0 and hip_cm < 500)),
	CONSTRAINT "measurements_not_empty" CHECK (weight_kg is not null or height_cm is not null or body_fat_pct is not null or waist_cm is not null or hip_cm is not null)
);
--> statement-breakpoint
ALTER TABLE "measurements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "measurements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "measurements_client_id_measured_at_idx" ON "measurements" USING btree ("client_id","measured_at");--> statement-breakpoint
CREATE POLICY "measurements_tenant_isolation" ON "measurements" AS PERMISSIVE FOR ALL TO "authenticated_backend" USING ("measurements"."tenant_id" = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1)) WITH CHECK ("measurements"."tenant_id" = (select tenant_id from tenant_members where user_id = current_setting('app.user_id', true) limit 1));