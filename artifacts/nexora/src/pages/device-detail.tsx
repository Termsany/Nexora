import { useMemo, useState } from 'react';
import { Link, useParams } from 'wouter';
import { ArrowLeft, ChevronRight, Cpu, HardDrive, Network, RefreshCw, ShieldCheck, UserRound, Wifi } from 'lucide-react';
import { getGetDashboardActivityQueryKey, getGetDeviceMetricsQueryKey, getGetDeviceQueryKey, useGetDashboardActivity, useGetDevice, useGetDeviceMetrics } from '@workspace/api-client-react';
import type { ActivityEvent, DeviceDetails, Hardware, Metric, Disk, NetworkInterface } from '@workspace/api-client-react';
import { AppShell, PageIntro } from '@/components/app-shell';
import { InlineNotice, LoadingRows, MetricCard, Panel, PanelHeading, QueryState, StatusPill } from '@/components/console-ui';

type Tab = 'overview' | 'hardware' | 'disks' | 'network' | 'activity';

function formatBytes(bytes?: number | null) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function uptime(seconds?: number | null) {
  if (!seconds) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days ? `${days}d ` : ''}${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export default function DeviceDetail() {
  const params = useParams<{ deviceId: string }>();
  const deviceId = params.deviceId ?? '';
  const [tab, setTab] = useState<Tab>('overview');
  const deviceQuery = useGetDevice(deviceId, { query: { enabled: Boolean(deviceId), queryKey: getGetDeviceQueryKey(deviceId) } });
  const metricsQuery = useGetDeviceMetrics(deviceId, { query: { enabled: Boolean(deviceId), queryKey: getGetDeviceMetricsQueryKey(deviceId), refetchInterval: 30000 } });
  const activityQuery = useGetDashboardActivity({ query: { queryKey: getGetDashboardActivityQueryKey() } });
  const device = deviceQuery.data;
  const metrics = metricsQuery.data ?? [];
  const deviceActivity = useMemo(() => activityQuery.data?.filter((event) => event.device_id === deviceId) ?? [], [activityQuery.data, deviceId]);
  const latest = metrics.at(-1);

  if (deviceQuery.isLoading) return <AppShell><PageIntro eyebrow="Endpoint detail" title="Loading endpoint" /><Panel><LoadingRows count={5} /></Panel></AppShell>;
  if (deviceQuery.isError || !device) return <AppShell><PageIntro eyebrow="Endpoint detail" title="Endpoint unavailable" /><Panel><QueryState kind="error" onRetry={() => void deviceQuery.refetch()} /></Panel></AppShell>;

  const tabs: { value: Tab; label: string; icon: typeof Cpu }[] = [{ value: 'overview', label: 'Overview', icon: ShieldCheck }, { value: 'hardware', label: 'Hardware', icon: Cpu }, { value: 'disks', label: 'Disks', icon: HardDrive }, { value: 'network', label: 'Network', icon: Network }, { value: 'activity', label: 'Activity', icon: Wifi }];
  return <AppShell><div className="mb-4 flex items-center gap-2 text-[11px] text-muted-foreground"><Link href="/devices" className="inline-flex items-center gap-1 transition-colors hover:text-primary" data-testid="link-back-devices"><ArrowLeft size={13} /> Devices</Link><ChevronRight size={13} /><span className="font-mono-data text-primary">{device.hostname}</span></div><PageIntro eyebrow="Endpoint detail" title={device.hostname} description={`${device.os_name || 'Windows endpoint'}${device.os_build ? ` · ${device.os_build}` : ''} · Agent ${device.agent_version || 'version unavailable'}`} action={<div className="flex items-center gap-3"><StatusPill status={device.status} /><button type="button" onClick={() => { void deviceQuery.refetch(); void metricsQuery.refetch(); }} className="rounded-md border border-border bg-card p-2 text-muted-foreground transition-colors hover:border-accent hover:text-primary" aria-label="Refresh endpoint" data-testid="button-refresh-device"><RefreshCw size={15} className={deviceQuery.isFetching ? 'animate-spin' : ''} /></button></div>} />
    {device.status !== 'ONLINE' && <div className="mb-5"><InlineNotice tone={device.status === 'OFFLINE' ? 'red' : 'amber'}>{device.status === 'OFFLINE' ? 'This endpoint is not responding. Values below reflect the last inventory received.' : 'This endpoint has not established a current state yet. Treat live metrics as provisional.'}</InlineNotice></div>}
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-border"><div className="flex min-w-max gap-1">{tabs.map((item) => { const Icon = item.icon; return <button type="button" key={item.value} onClick={() => setTab(item.value)} className={`flex items-center gap-2 border-b-2 px-3 py-3 text-[11px] font-semibold transition-colors ${tab === item.value ? 'border-accent text-primary' : 'border-transparent text-muted-foreground hover:text-primary'}`} data-testid={`tab-device-${item.value}`}><Icon size={14} />{item.label}</button>; })}</div></div>
    {tab === 'overview' && <OverviewTab device={device} latest={latest} metrics={metrics} metricsLoading={metricsQuery.isLoading} />}
    {tab === 'hardware' && <HardwareTab hardware={device.hardware} device={device} />}
    {tab === 'disks' && <DisksTab disks={device.disks} />}
    {tab === 'network' && <NetworkTab network={device.network} />}
    {tab === 'activity' && <ActivityTab events={deviceActivity} loading={activityQuery.isLoading} />}
  </AppShell>;
}

function OverviewTab({ device, latest, metrics, metricsLoading }: { device: DeviceDetails; latest: Metric | undefined; metrics: Metric[]; metricsLoading: boolean }) {
  const identityRows: Array<[string, string, typeof UserRound]> = [
    ['Current user', device.current_user || 'Not reported', UserRound],
    ['Domain', device.domain || 'Not joined', ShieldCheck],
    ['IP address', device.ip_address || 'Not reported', Network],
    ['Architecture', device.architecture || 'Not reported', Cpu],
  ];
  return <><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="CPU utilization" value={`${(latest?.cpu_percent ?? device.cpu_percent ?? 0).toFixed(1)}%`} detail="Most recent sample" tone="navy" /><MetricCard label="Memory utilization" value={`${(latest?.ram_percent ?? device.ram_percent ?? 0).toFixed(1)}%`} detail="Most recent sample" tone="mint" /><MetricCard label="Primary disk" value={`${(latest?.disk_percent ?? device.disk_percent ?? 0).toFixed(1)}%`} detail="Used capacity" tone={(latest?.disk_percent ?? device.disk_percent ?? 0) > 80 ? 'amber' : 'navy'} /><MetricCard label="Uptime" value={uptime(latest?.uptime_seconds ?? device.uptime_seconds)} detail="Since last reboot" tone="navy" /></div><div className="mt-5 grid gap-5 xl:grid-cols-[1.2fr_.8fr]"><Panel><PanelHeading eyebrow="Live telemetry" title="Metric history" meta={metrics.length ? `${metrics.length} samples available` : 'No samples stored for this endpoint'} />{metricsLoading ? <LoadingRows count={4} /> : metrics.length === 0 ? <QueryState kind="empty" /> : <div className="p-5"><div className="flex h-40 items-end gap-1.5 border-b border-l border-border px-3 pb-0 pt-5">{metrics.slice(-28).map((metric, index) => <div key={`${metric.captured_at}-${index}`} className="group relative flex h-full flex-1 items-end gap-0.5"><div className="w-1/2 rounded-t-sm bg-primary/75 transition-all group-hover:bg-accent" style={{ height: `${Math.max(4, metric.cpu_percent)}%` }} /><div className="w-1/2 rounded-t-sm bg-[#22a976]/75 transition-all group-hover:bg-[#22a976]" style={{ height: `${Math.max(4, metric.ram_percent)}%` }} /></div>)}</div><div className="mt-3 flex items-center justify-center gap-5 text-[10px] text-muted-foreground"><span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-primary" />CPU</span><span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-[#22a976]" />RAM</span></div></div>}</Panel><Panel><PanelHeading eyebrow="Identity" title="Endpoint profile" /><div className="divide-y divide-border/60 px-5">{identityRows.map(([label, value, Icon]) => <div key={label} className="flex items-center gap-3 py-3.5"><Icon size={15} className="text-muted-foreground" /><div className="min-w-0"><p className="text-[10px] text-muted-foreground">{label}</p><p className="truncate text-[12px] font-semibold text-primary">{value}</p></div></div>)}</div></Panel></div></>;
}

function HardwareTab({ hardware, device }: { hardware: Hardware; device: DeviceDetails }) {
  const rows = [['Manufacturer', hardware.manufacturer], ['Model', hardware.model], ['CPU model', hardware.cpu_model], ['Logical processors', hardware.logical_processors?.toString()], ['Total memory', formatBytes(hardware.total_ram_bytes)], ['BIOS version', hardware.bios_version], ['OS version', device.os_version], ['OS build', device.os_build]];
  return <Panel><PanelHeading eyebrow="Hardware inventory" title="Machine specification" meta="Reported from the latest inventory payload" /><div className="grid gap-px bg-border/60 sm:grid-cols-2">{rows.map(([label, value]) => <div key={label} className="bg-card px-5 py-4"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 text-[13px] font-semibold text-primary">{value || 'Not reported'}</p></div>)}</div></Panel>;
}

function DisksTab({ disks }: { disks: Disk[] }) {
  return disks.length === 0 ? <Panel><QueryState kind="empty" /></Panel> : <Panel><PanelHeading eyebrow="Storage inventory" title="Disks" meta={`${disks.length} volumes reported`} /><div className="scrollbar-thin overflow-x-auto"><table className="w-full min-w-[620px]"><thead><tr className="bg-muted/45 text-left text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground"><th className="px-5 py-3">Drive</th><th className="px-4 py-3">Filesystem</th><th className="px-4 py-3">Used</th><th className="px-4 py-3">Capacity</th><th className="px-4 py-3">Free</th></tr></thead><tbody className="divide-y divide-border/60">{disks.map((disk) => <tr key={`${disk.drive}-${disk.filesystem}`}><td className="px-5 py-4 font-mono-data text-[12px] font-bold text-primary">{disk.drive}</td><td className="px-4 py-4 text-[11px] text-muted-foreground">{disk.filesystem}</td><td className="px-4 py-4"><div className="flex items-center gap-3"><div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${disk.used_percent > 80 ? 'bg-destructive' : disk.used_percent > 65 ? 'bg-accent' : 'bg-[#22a976]'}`} style={{ width: `${disk.used_percent}%` }} /></div><span className="font-mono-data text-[11px] text-primary">{disk.used_percent.toFixed(1)}%</span></div></td><td className="px-4 py-4 font-mono-data text-[11px] text-primary">{formatBytes(disk.total_bytes)}</td><td className="px-4 py-4 font-mono-data text-[11px] text-muted-foreground">{formatBytes(disk.free_bytes)}</td></tr>)}</tbody></table></div></Panel>;
}

function NetworkTab({ network }: { network: NetworkInterface[] }) {
  return network.length === 0 ? <Panel><QueryState kind="empty" /></Panel> : <div className="grid gap-5 lg:grid-cols-2">{network.map((item) => <Panel key={`${item.name}-${item.mac}`}><PanelHeading eyebrow={item.interface_type} title={item.name} /><div className="grid gap-px bg-border/60 sm:grid-cols-2"><div className="bg-card px-5 py-4"><p className="text-[10px] text-muted-foreground">IPv4</p><p className="mt-1 font-mono-data text-[12px] font-bold text-primary">{item.ipv4}</p></div><div className="bg-card px-5 py-4"><p className="text-[10px] text-muted-foreground">MAC address</p><p className="mt-1 font-mono-data text-[12px] text-primary">{item.mac}</p></div><div className="bg-card px-5 py-4"><p className="text-[10px] text-muted-foreground">Gateway</p><p className="mt-1 font-mono-data text-[12px] text-primary">{item.gateway || 'Not reported'}</p></div><div className="bg-card px-5 py-4"><p className="text-[10px] text-muted-foreground">DNS servers</p><p className="mt-1 text-[12px] text-primary">{item.dns_servers.length ? item.dns_servers.join(', ') : 'Not reported'}</p></div></div></Panel>)}</div>;
}

function ActivityTab({ events, loading }: { events: ActivityEvent[]; loading: boolean }) {
  return <Panel><PanelHeading eyebrow="Event log" title="Endpoint activity" meta="Recent events associated with this device" />{loading ? <LoadingRows count={4} /> : events.length === 0 ? <QueryState kind="empty" /> : <div className="divide-y divide-border/60">{events.map((event) => <div key={event.id} className="flex items-center gap-4 px-5 py-4"><div className="h-2 w-2 rounded-full bg-accent" /><div className="flex-1"><p className="text-[12px] font-semibold text-primary">{event.event.replaceAll('_', ' ')}</p><p className="mt-1 font-mono-data text-[10px] text-muted-foreground">{event.hostname}</p></div><time className="font-mono-data text-[10px] text-muted-foreground">{new Date(event.timestamp).toLocaleString()}</time></div>)}</div>}</Panel>;
}