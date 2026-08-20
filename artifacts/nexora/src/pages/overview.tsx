import { useMemo } from 'react';
import { Link } from 'wouter';
import { Activity, ArrowUpRight, BarChart3, HardDrive, RefreshCw, Server, Wifi } from 'lucide-react';
import { getGetDashboardActivityQueryKey, getGetDashboardSummaryQueryKey, useGetDashboardActivity, useGetDashboardSummary } from '@workspace/api-client-react';
import { AppShell, PageIntro } from '@/components/app-shell';
import { MetricCard, Panel, PanelHeading, QueryState } from '@/components/console-ui';

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

export default function Overview() {
  const summaryQuery = useGetDashboardSummary({ query: { queryKey: getGetDashboardSummaryQueryKey(), refetchInterval: 30000 } });
  const activityQuery = useGetDashboardActivity({ query: { queryKey: getGetDashboardActivityQueryKey(), refetchInterval: 30000 } });
  const summary = summaryQuery.data;
  const activity = activityQuery.data ?? [];
  const healthPercent = summary && summary.total_devices > 0 ? Math.round((summary.online_devices / summary.total_devices) * 100) : 0;
  const statusBreakdown = useMemo(() => summary ? [
    { label: 'Online', value: summary.online_devices, color: '#22a976' },
    { label: 'Offline', value: summary.offline_devices, color: '#d45749' },
    { label: 'Unknown', value: summary.unknown_devices, color: '#d59a25' },
  ] : [], [summary]);

  return <AppShell><PageIntro eyebrow="Operational overview" title="Fleet health, at a glance." description="A live read on the endpoints reporting into Northstar IT." action={<button type="button" onClick={() => { void summaryQuery.refetch(); void activityQuery.refetch(); }} className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3.5 py-2.5 text-[11px] font-semibold text-primary shadow-xs transition-colors hover:border-accent hover:bg-[#fff9e9]" data-testid="button-refresh-overview"><RefreshCw size={14} className={summaryQuery.isFetching || activityQuery.isFetching ? 'animate-spin' : ''} /> Refresh data</button>} />
    {summaryQuery.isLoading ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><div className="col-span-full grid h-28 animate-pulse rounded-lg bg-muted" /></div> : summaryQuery.isError || !summary ? <Panel><QueryState kind="error" onRetry={() => void summaryQuery.refetch()} /></Panel> : <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Total endpoints" value={summary.total_devices} detail="Enrolled Windows devices" tone="navy" />
        <MetricCard label="Online now" value={summary.online_devices} detail={`${healthPercent}% of enrolled fleet`} tone="mint" trend="up" />
        <MetricCard label="Offline" value={summary.offline_devices} detail="Needs a technician look" tone="red" trend="down" />
        <MetricCard label="Disk pressure" value={summary.disks_over_threshold} detail="Endpoints above threshold" tone="amber" />
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
      <div className="mt-5 grid gap-5 xl:grid-cols-[1.3fr_.7fr]">
        <Panel className="animate-rise-in [animation-delay:220ms]">
          <PanelHeading eyebrow="Latest signals" title="Recent activity" meta="Most recent events from the endpoint fleet" action={<Link href="/devices" className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#b57504] hover:underline" data-testid="link-view-devices">View inventory <ArrowUpRight size={13} /></Link>} />
          {activityQuery.isLoading ? <div className="p-5"><div className="h-40 animate-pulse rounded-md bg-muted" /></div> : activityQuery.isError ? <QueryState kind="error" onRetry={() => void activityQuery.refetch()} /> : activity.length === 0 ? <QueryState kind="empty" /> : <div className="divide-y divide-border/60">{activity.slice(0, 7).map((item) => <Link href={`/devices/${item.device_id}`} key={item.id} className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-muted/45" data-testid={`activity-event-${item.id}`}><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-primary"><ActivityIcon event={item.event} /></div><div className="min-w-0 flex-1"><p className="truncate text-[12px] font-semibold text-primary group-hover:text-[#b57504]">{formatEvent(item.event)}</p><p className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.hostname} <span className="mx-1 text-border">/</span> {item.device_id.slice(0, 12)}</p></div><span className="shrink-0 font-mono-data text-[10px] text-muted-foreground">{formatRelative(item.timestamp)}</span></Link>)}</div>}
        </Panel>
        <Panel className="animate-rise-in [animation-delay:280ms]">
          <PanelHeading eyebrow="Operator note" title="Keep the fleet quiet." />
          <div className="grid-lines min-h-[204px] p-5"><div className="flex h-full min-h-[164px] flex-col justify-between rounded-md border border-dashed border-accent/40 bg-card/80 p-4"><div><div className="mb-4 flex h-8 w-8 items-center justify-center rounded-md bg-[#fff0cc] text-[#a66c04]"><Activity size={16} /></div><p className="text-[13px] font-semibold leading-5 text-primary">A healthy endpoint is a quiet endpoint.</p><p className="mt-2 text-[11px] leading-5 text-muted-foreground">Use Devices to inspect a machine before an alert becomes a ticket.</p></div><Link href="/devices" className="mt-4 flex items-center gap-1 text-[11px] font-bold text-[#b57504] hover:gap-2 transition-all" data-testid="link-inspect-fleet">Inspect fleet <ArrowUpRight size={13} /></Link></div></div>
        </Panel>
      </div>
    </>}</AppShell>;
}

function ActivityIcon({ event }: { event: string }) {
  if (event.toLowerCase().includes('offline')) return <span className="h-2.5 w-2.5 rounded-full bg-destructive" />;
  if (event.toLowerCase().includes('online')) return <span className="h-2.5 w-2.5 rounded-full bg-[#22a976]" />;
  return <span className="h-2.5 w-2.5 rounded-sm border-2 border-accent" />;
}