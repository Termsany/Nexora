import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Activity, ArrowUpRight, BarChart3, HardDrive, RefreshCw, Server, Wifi } from 'lucide-react';
import { getGetDashboardActivityQueryKey, getGetDashboardSummaryQueryKey, useGetDashboardActivity, useGetDashboardSummary } from '@workspace/api-client-react';
import { AppShell, PageIntro } from '@/components/app-shell';
import { MetricCard, Panel, PanelHeading, QueryState } from '@/components/console-ui';
import { AlertPill, alertTypeLabel, relativeAge, type AlertRecord } from '@/pages/alerts';

function formatRelative(timestamp: string) {
  const diff = Math.max(0, Date.now() - new Date(timestamp).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatEvent(event: string) {
  return event.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

type HealthDevice = { id: string; hostname: string; status: string; health: string; cpu_percent: number | null; ram_percent: number | null; disk_percent: number | null; last_seen_at: string | null };
type HealthOverview = { warning_devices: number; critical_devices: number; devices: HealthDevice[]; highest_cpu: HealthDevice[]; highest_memory: HealthDevice[]; highest_disk: HealthDevice[] };
type AlertOverview = { active_alerts: number; critical_alerts: number; warning_alerts: number; recent: AlertRecord[] };

export default function Overview() {
  const summaryQuery = useGetDashboardSummary({ query: { queryKey: getGetDashboardSummaryQueryKey(), refetchInterval: 30000 } });
  const activityQuery = useGetDashboardActivity({ query: { queryKey: getGetDashboardActivityQueryKey(), refetchInterval: 30000 } });
  const healthQuery = useQuery({ queryKey: ['dashboard-health'], refetchInterval: 30000, queryFn: async () => { const response = await fetch('/api/v1/dashboard/health'); if (!response.ok) throw new Error('Health query failed'); return response.json() as Promise<HealthOverview>; } });
  const alertQuery = useQuery({ queryKey: ['dashboard-alerts'], refetchInterval: 30000, queryFn: async () => { const response = await fetch('/api/v1/dashboard/alerts'); if (!response.ok) throw new Error('Alert query failed'); return response.json() as Promise<AlertOverview>; } });
  const summary = summaryQuery.data;
  const activity = activityQuery.data ?? [];
  const healthPercent = summary && summary.total_devices > 0 ? Math.round((summary.online_devices / summary.total_devices) * 100) : 0;
  const statusBreakdown = useMemo(() => summary ? [
    { label: 'Online', value: summary.online_devices, color: '#22a976' },
    { label: 'Offline', value: summary.offline_devices, color: '#d45749' },
    { label: 'Unknown', value: summary.unknown_devices, color: '#d59a25' },
  ] : [], [summary]);

  return <AppShell><PageIntro eyebrow="Operational overview" title="Fleet health, at a glance." description="A live read on the endpoints reporting into Northstar IT." action={<button type="button" onClick={() => { void summaryQuery.refetch(); void activityQuery.refetch(); void healthQuery.refetch(); void alertQuery.refetch(); }} className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3.5 py-2.5 text-[11px] font-semibold text-primary shadow-xs transition-colors hover:border-accent hover:bg-[#fff9e9]" data-testid="button-refresh-overview"><RefreshCw size={14} className={summaryQuery.isFetching || activityQuery.isFetching || alertQuery.isFetching ? 'animate-spin' : ''} /> Refresh data</button>} />
    {summaryQuery.isLoading ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><div className="col-span-full grid h-28 animate-pulse rounded-lg bg-muted" /></div> : summaryQuery.isError || !summary ? <Panel><QueryState kind="error" onRetry={() => void summaryQuery.refetch()} /></Panel> : <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Total endpoints" value={summary.total_devices} detail="Enrolled Windows devices" tone="navy" />
        <MetricCard label="Online now" value={summary.online_devices} detail={`${healthPercent}% of enrolled fleet`} tone="mint" trend="up" />
        <MetricCard label="Offline" value={summary.offline_devices} detail="Needs a technician look" tone="red" trend="down" />
        <MetricCard label="Warning" value={healthQuery.data?.warning_devices ?? '—'} detail="Sustained resource pressure" tone="amber" />
        <MetricCard label="Critical" value={healthQuery.data?.critical_devices ?? '—'} detail="Immediate resource pressure" tone="red" />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <MetricCard label="Active alerts" value={alertQuery.data?.active_alerts ?? '—'} detail="Open and acknowledged incidents" tone="navy" />
        <MetricCard label="Critical alerts" value={alertQuery.data?.critical_alerts ?? '—'} detail="Active critical incidents" tone="red" />
        <MetricCard label="Warning alerts" value={alertQuery.data?.warning_alerts ?? '—'} detail="Active warning incidents" tone="amber" />
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-[1.12fr_.88fr]">
        <Panel className="animate-rise-in [animation-delay:100ms]">
          <PanelHeading eyebrow="Fleet signal" title="Endpoint availability" meta="Current state across all enrolled devices" action={<div className="flex items-center gap-1.5 text-[10px] font-semibold text-[#148d67]"><span className="h-1.5 w-1.5 rounded-full bg-[#22a976] animate-pulse-dot" />Live</div>} />
          <div className="grid gap-7 p-5 md:grid-cols-[minmax(180px,.7fr)_1fr] md:items-center">
            <div className="relative mx-auto flex h-44 w-44 items-center justify-center rounded-full" style={{ background: `conic-gradient(#22a976 ${healthPercent}%, #d45749 ${healthPercent}% ${healthPercent + (summary.total_devices ? (summary.offline_devices / summary.total_devices) * 100 : 0)}%, #d59a25 0)` }}>
              <div className="flex h-32 w-32 flex-col items-center justify-center rounded-full bg-card"><span className="font-mono-data text-3xl font-bold text-primary">{healthPercent}%</span><span className="mt-1 text-[10px] text-muted-foreground">online</span></div>
            </div>
            <div className="space-y-5">
              {statusBreakdown.map((item) => <div key={item.label}><div className="mb-2 flex items-center justify-between text-[11px]"><span className="flex items-center gap-2 font-medium text-primary"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />{item.label}</span><span className="font-mono-data text-muted-foreground">{item.value}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full transition-all duration-700" style={{ width: `${summary.total_devices ? (item.value / summary.total_devices) * 100 : 0}%`, backgroundColor: item.color }} /></div></div>)}
              <div className="border-t border-border/70 pt-4"><div className="flex items-center justify-between text-[11px]"><span className="text-muted-foreground">Unclassified signals</span><span className="font-mono-data text-primary">{summary.unknown_devices}</span></div></div>
            </div>
          </div>
        </Panel>
        <Panel className="animate-rise-in [animation-delay:160ms]">
          <PanelHeading eyebrow="Resource pulse" title="Average utilization" meta="Across reporting endpoints" />
          <div className="space-y-6 p-5">
            <div><div className="mb-2 flex justify-between"><span className="flex items-center gap-2 text-[12px] font-medium"><BarChart3 size={15} className="text-muted-foreground" /> CPU</span><span className="font-mono-data text-[13px] font-bold text-primary">{summary.average_cpu.toFixed(1)}%</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all duration-700" style={{ width: `${Math.min(100, summary.average_cpu)}%` }} /></div></div>
            <div><div className="mb-2 flex justify-between"><span className="flex items-center gap-2 text-[12px] font-medium"><Server size={15} className="text-muted-foreground" /> Memory</span><span className="font-mono-data text-[13px] font-bold text-primary">{summary.average_ram.toFixed(1)}%</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-[#22a976] transition-all duration-700" style={{ width: `${Math.min(100, summary.average_ram)}%` }} /></div></div>
            <div className="grid grid-cols-2 gap-3 border-t border-border/70 pt-5"><div className="rounded-md bg-muted/65 p-3"><HardDrive size={15} className="mb-2 text-[#b57504]" /><p className="font-mono-data text-lg font-bold text-primary">{summary.disks_over_threshold}</p><p className="mt-1 text-[10px] text-muted-foreground">Disk alerts</p></div><div className="rounded-md bg-muted/65 p-3"><Wifi size={15} className="mb-2 text-[#148d67]" /><p className="font-mono-data text-lg font-bold text-primary">{summary.unknown_devices}</p><p className="mt-1 text-[10px] text-muted-foreground">Unknown state</p></div></div>
          </div>
        </Panel>
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <PressurePanel title="Highest CPU" devices={healthQuery.data?.highest_cpu ?? []} field="cpu_percent" />
        <PressurePanel title="Highest memory" devices={healthQuery.data?.highest_memory ?? []} field="ram_percent" />
        <PressurePanel title="Highest disk" devices={healthQuery.data?.highest_disk ?? []} field="disk_percent" />
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-[1.3fr_.7fr]">
        <Panel className="animate-rise-in [animation-delay:220ms]">
          <PanelHeading eyebrow="Latest signals" title="Recent activity" meta="Most recent events from the endpoint fleet" action={<Link href="/devices" className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#b57504] hover:underline" data-testid="link-view-devices">View inventory <ArrowUpRight size={13} /></Link>} />
          {activityQuery.isLoading ? <div className="p-5"><div className="h-40 animate-pulse rounded-md bg-muted" /></div> : activityQuery.isError ? <QueryState kind="error" onRetry={() => void activityQuery.refetch()} /> : activity.length === 0 ? <QueryState kind="empty" /> : <div className="divide-y divide-border/60">{activity.slice(0, 7).map((item) => <Link href={`/devices/${item.device_id}`} key={item.id} className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-muted/45" data-testid={`activity-event-${item.id}`}><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-primary"><ActivityIcon event={item.event} /></div><div className="min-w-0 flex-1"><p className="truncate text-[12px] font-semibold text-primary group-hover:text-[#b57504]">{formatEvent(item.event)}</p><p className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.hostname} <span className="mx-1 text-border">/</span> {item.device_id.slice(0, 12)}</p></div><span className="shrink-0 font-mono-data text-[10px] text-muted-foreground">{formatRelative(item.timestamp)}</span></Link>)}</div>}
        </Panel>
        <Panel className="animate-rise-in [animation-delay:280ms]"><PanelHeading eyebrow="Alert lifecycle" title="Active alerts" action={<Link href="/alerts" className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#b57504]">View all <ArrowUpRight size={13} /></Link>} />{alertQuery.data?.recent.length ? <div className="divide-y divide-border">{alertQuery.data.recent.map((alert) => <Link href="/alerts" key={alert.id} className="flex items-center gap-3 px-5 py-3.5 hover:bg-muted/45"><AlertPill value={alert.severity} /><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold text-primary">{alertTypeLabel(alert.type)}</p><p className="text-[10px] text-muted-foreground">{alert.device.hostname} · {alert.state}</p></div><span className="font-mono-data text-[10px] text-muted-foreground">{relativeAge(alert.last_triggered_at)}</span></Link>)}</div> : <div className="flex min-h-[204px] items-center justify-center text-[11px] text-muted-foreground">No active alerts</div>}</Panel>
      </div>
    </>}</AppShell>;
}

function PressurePanel({ title, devices, field }: { title: string; devices: HealthDevice[]; field: 'cpu_percent' | 'ram_percent' | 'disk_percent' }) {
  return <Panel><PanelHeading eyebrow="Resource pressure" title={title} />{devices.length === 0 ? <div className="p-5 text-[11px] text-muted-foreground">No telemetry available</div> : <div className="divide-y divide-border/60">{devices.map((device) => <Link href={`/devices/${device.id}`} key={device.id} className="flex items-center gap-3 px-5 py-3 hover:bg-muted/45"><span className={`h-2 w-2 rounded-full ${device.health === 'CRITICAL' ? 'bg-destructive' : device.health === 'WARNING' ? 'bg-accent' : 'bg-[#22a976]'}`} /><span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-primary">{device.hostname}</span><span className="font-mono-data text-[11px] text-muted-foreground">{device[field] == null ? '—' : `${device[field]!.toFixed(1)}%`}</span></Link>)}</div>}</Panel>;
}

function ActivityIcon({ event }: { event: string }) {
  if (event.toLowerCase().includes('offline')) return <span className="h-2.5 w-2.5 rounded-full bg-destructive" />;
  if (event.toLowerCase().includes('online')) return <span className="h-2.5 w-2.5 rounded-full bg-[#22a976]" />;
  return <span className="h-2.5 w-2.5 rounded-sm border-2 border-accent" />;
}
