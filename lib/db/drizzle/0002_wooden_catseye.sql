CREATE TABLE "nexora_disk_metric_aggregates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"volume" text NOT NULL,
	"resolution" text NOT NULL,
	"bucket_at" timestamp with time zone NOT NULL,
	"usage_avg" double precision NOT NULL,
	"usage_min" double precision NOT NULL,
	"usage_max" double precision NOT NULL,
	"usage_latest" double precision NOT NULL,
	"total_bytes_latest" bigint NOT NULL,
	"used_bytes_latest" bigint NOT NULL,
	"free_bytes_latest" bigint NOT NULL,
	"sample_count" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nexora_disk_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"metric_id" uuid,
	"volume" text NOT NULL,
	"filesystem" text,
	"total_bytes" bigint NOT NULL,
	"used_bytes" bigint NOT NULL,
	"free_bytes" bigint NOT NULL,
	"used_percent" double precision NOT NULL,
	"captured_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nexora_metric_aggregates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"resolution" text NOT NULL,
	"bucket_at" timestamp with time zone NOT NULL,
	"cpu_avg" double precision NOT NULL,
	"cpu_min" double precision NOT NULL,
	"cpu_max" double precision NOT NULL,
	"ram_avg" double precision NOT NULL,
	"ram_min" double precision NOT NULL,
	"ram_max" double precision NOT NULL,
	"ram_used_avg_bytes" double precision NOT NULL,
	"ram_available_avg_bytes" double precision NOT NULL,
	"uptime_latest_seconds" integer NOT NULL,
	"sample_count" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nexora_disk_metric_aggregates" ADD CONSTRAINT "nexora_disk_metric_aggregates_device_id_nexora_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."nexora_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_disk_metrics" ADD CONSTRAINT "nexora_disk_metrics_device_id_nexora_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."nexora_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_disk_metrics" ADD CONSTRAINT "nexora_disk_metrics_metric_id_nexora_device_metrics_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."nexora_device_metrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexora_metric_aggregates" ADD CONSTRAINT "nexora_metric_aggregates_device_id_nexora_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."nexora_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nexora_disk_metric_aggregates_bucket_uidx" ON "nexora_disk_metric_aggregates" USING btree ("device_id","volume","resolution","bucket_at");--> statement-breakpoint
CREATE INDEX "nexora_disk_metric_aggregates_query_idx" ON "nexora_disk_metric_aggregates" USING btree ("device_id","volume","resolution","bucket_at");--> statement-breakpoint
CREATE INDEX "nexora_disk_metrics_device_received_idx" ON "nexora_disk_metrics" USING btree ("device_id","received_at");--> statement-breakpoint
CREATE INDEX "nexora_disk_metrics_device_volume_received_idx" ON "nexora_disk_metrics" USING btree ("device_id","volume","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nexora_disk_metrics_metric_volume_uidx" ON "nexora_disk_metrics" USING btree ("metric_id","volume");--> statement-breakpoint
CREATE UNIQUE INDEX "nexora_metric_aggregates_bucket_uidx" ON "nexora_metric_aggregates" USING btree ("device_id","resolution","bucket_at");--> statement-breakpoint
CREATE INDEX "nexora_metric_aggregates_query_idx" ON "nexora_metric_aggregates" USING btree ("device_id","resolution","bucket_at");