CREATE TABLE "nexora_agent_request_nonces" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "device_id" uuid NOT NULL REFERENCES "nexora_devices"("id") ON DELETE CASCADE, "signing_key_id" uuid NOT NULL REFERENCES "nexora_agent_signing_keys"("id") ON DELETE CASCADE, "nonce_hash" text NOT NULL, "request_timestamp" bigint NOT NULL, "expires_at" timestamptz NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(), CONSTRAINT "nexora_agent_nonce_unique" UNIQUE ("device_id","nonce_hash")
);--> statement-breakpoint
CREATE INDEX "nexora_agent_nonce_expiry_idx" ON "nexora_agent_request_nonces" ("expires_at");--> statement-breakpoint
CREATE INDEX "nexora_agent_nonce_device_idx" ON "nexora_agent_request_nonces" ("device_id");
