import { retentionCutoffs } from "./policy.ts";

type SqlClient = { query(sql: string, values?: unknown[]): Promise<{ rowCount: number | null }> };

export async function runTelemetryMaintenance(client: SqlClient, mode: "full" | "incremental" = "full") {
  const cutoffs = retentionCutoffs();
  const rawScope = mode === "incremental" ? "WHERE received_at >= now() - interval '2 hours'" : "";
  const hourlyScope = mode === "incremental" ? "AND bucket_at >= now() - interval '2 days'" : "";
  await client.query("BEGIN");
  try {
    await client.query(`
      INSERT INTO nexora_metric_aggregates
        (device_id, resolution, bucket_at, cpu_avg, cpu_min, cpu_max, ram_avg, ram_min, ram_max,
         ram_used_avg_bytes, ram_available_avg_bytes, uptime_latest_seconds, sample_count, updated_at)
      SELECT device_id, 'hour', date_trunc('hour', received_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', avg(cpu_percent), min(cpu_percent), max(cpu_percent),
        avg(ram_percent), min(ram_percent), max(ram_percent), avg(ram_used_bytes), avg(ram_available_bytes),
        (array_agg(uptime_seconds ORDER BY received_at DESC))[1], count(*)::int, now()
      FROM nexora_device_metrics ${rawScope} GROUP BY device_id, 3
      ON CONFLICT (device_id, resolution, bucket_at) DO UPDATE SET
        cpu_avg=excluded.cpu_avg, cpu_min=excluded.cpu_min, cpu_max=excluded.cpu_max,
        ram_avg=excluded.ram_avg, ram_min=excluded.ram_min, ram_max=excluded.ram_max,
        ram_used_avg_bytes=excluded.ram_used_avg_bytes, ram_available_avg_bytes=excluded.ram_available_avg_bytes,
        uptime_latest_seconds=excluded.uptime_latest_seconds, sample_count=excluded.sample_count, updated_at=now()`);

    await client.query(`
      INSERT INTO nexora_disk_metric_aggregates
        (device_id, volume, resolution, bucket_at, usage_avg, usage_min, usage_max, usage_latest,
         total_bytes_latest, used_bytes_latest, free_bytes_latest, sample_count, updated_at)
      SELECT device_id, volume, 'hour', date_trunc('hour', received_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', avg(used_percent), min(used_percent), max(used_percent),
        (array_agg(used_percent ORDER BY received_at DESC))[1], (array_agg(total_bytes ORDER BY received_at DESC))[1],
        (array_agg(used_bytes ORDER BY received_at DESC))[1], (array_agg(free_bytes ORDER BY received_at DESC))[1], count(*)::int, now()
      FROM nexora_disk_metrics ${rawScope} GROUP BY device_id, volume, 4
      ON CONFLICT (device_id, volume, resolution, bucket_at) DO UPDATE SET
        usage_avg=excluded.usage_avg, usage_min=excluded.usage_min, usage_max=excluded.usage_max, usage_latest=excluded.usage_latest,
        total_bytes_latest=excluded.total_bytes_latest, used_bytes_latest=excluded.used_bytes_latest,
        free_bytes_latest=excluded.free_bytes_latest, sample_count=excluded.sample_count, updated_at=now()`);

    await client.query(`
      INSERT INTO nexora_metric_aggregates
        (device_id, resolution, bucket_at, cpu_avg, cpu_min, cpu_max, ram_avg, ram_min, ram_max,
         ram_used_avg_bytes, ram_available_avg_bytes, uptime_latest_seconds, sample_count, updated_at)
      SELECT device_id, 'day', date_trunc('day', bucket_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', sum(cpu_avg*sample_count)/sum(sample_count), min(cpu_min), max(cpu_max),
        sum(ram_avg*sample_count)/sum(sample_count), min(ram_min), max(ram_max),
        sum(ram_used_avg_bytes*sample_count)/sum(sample_count), sum(ram_available_avg_bytes*sample_count)/sum(sample_count),
        (array_agg(uptime_latest_seconds ORDER BY bucket_at DESC))[1], sum(sample_count)::int, now()
      FROM nexora_metric_aggregates WHERE resolution='hour' ${hourlyScope} GROUP BY device_id, 3
      ON CONFLICT (device_id, resolution, bucket_at) DO UPDATE SET
        cpu_avg=excluded.cpu_avg, cpu_min=excluded.cpu_min, cpu_max=excluded.cpu_max,
        ram_avg=excluded.ram_avg, ram_min=excluded.ram_min, ram_max=excluded.ram_max,
        ram_used_avg_bytes=excluded.ram_used_avg_bytes, ram_available_avg_bytes=excluded.ram_available_avg_bytes,
        uptime_latest_seconds=excluded.uptime_latest_seconds, sample_count=excluded.sample_count, updated_at=now()`);

    await client.query(`
      INSERT INTO nexora_disk_metric_aggregates
        (device_id, volume, resolution, bucket_at, usage_avg, usage_min, usage_max, usage_latest,
         total_bytes_latest, used_bytes_latest, free_bytes_latest, sample_count, updated_at)
      SELECT device_id, volume, 'day', date_trunc('day', bucket_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', sum(usage_avg*sample_count)/sum(sample_count),
        min(usage_min), max(usage_max), (array_agg(usage_latest ORDER BY bucket_at DESC))[1],
        (array_agg(total_bytes_latest ORDER BY bucket_at DESC))[1], (array_agg(used_bytes_latest ORDER BY bucket_at DESC))[1],
        (array_agg(free_bytes_latest ORDER BY bucket_at DESC))[1], sum(sample_count)::int, now()
      FROM nexora_disk_metric_aggregates WHERE resolution='hour' ${hourlyScope} GROUP BY device_id, volume, 4
      ON CONFLICT (device_id, volume, resolution, bucket_at) DO UPDATE SET
        usage_avg=excluded.usage_avg, usage_min=excluded.usage_min, usage_max=excluded.usage_max, usage_latest=excluded.usage_latest,
        total_bytes_latest=excluded.total_bytes_latest, used_bytes_latest=excluded.used_bytes_latest,
        free_bytes_latest=excluded.free_bytes_latest, sample_count=excluded.sample_count, updated_at=now()`);

    const rawMetricDelete = await client.query("DELETE FROM nexora_device_metrics WHERE received_at < $1", [cutoffs.raw]);
    const rawDiskDelete = await client.query("DELETE FROM nexora_disk_metrics WHERE received_at < $1", [cutoffs.raw]);
    const hourlyMetricDelete = await client.query("DELETE FROM nexora_metric_aggregates WHERE resolution='hour' AND bucket_at < $1", [cutoffs.hour]);
    const hourlyDiskDelete = await client.query("DELETE FROM nexora_disk_metric_aggregates WHERE resolution='hour' AND bucket_at < $1", [cutoffs.hour]);
    const dailyMetricDelete = await client.query("DELETE FROM nexora_metric_aggregates WHERE resolution='day' AND bucket_at < $1", [cutoffs.day]);
    const dailyDiskDelete = await client.query("DELETE FROM nexora_disk_metric_aggregates WHERE resolution='day' AND bucket_at < $1", [cutoffs.day]);
    await client.query("COMMIT");
    return {
      rawMetricsDeleted: rawMetricDelete.rowCount ?? 0, rawDisksDeleted: rawDiskDelete.rowCount ?? 0,
      hourlyMetricsDeleted: hourlyMetricDelete.rowCount ?? 0, hourlyDisksDeleted: hourlyDiskDelete.rowCount ?? 0,
      dailyMetricsDeleted: dailyMetricDelete.rowCount ?? 0, dailyDisksDeleted: dailyDiskDelete.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
