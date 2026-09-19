CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_id_client_id_idx" ON "audit_log" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "client_consents_client_id_idx" ON "client_consents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "clients_tenant_id_live_idx" ON "clients" USING btree ("tenant_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tenant_members_tenant_id_idx" ON "tenant_members" USING btree ("tenant_id");