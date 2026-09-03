import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { ArrowLeft, Bell, Boxes, ChevronRight, Cpu, Gauge, HardDrive, Network, RefreshCw, ServerCog, ShieldCheck, SquareActivity, UserRound, Wifi } from 'lucide-react';
import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getGetDeviceQueryKey, useGetDevice } from '@workspace/api-client-react';
import type { DeviceDetails, Hardware, Disk, NetworkInterface } from '@workspace/api-client-react';
import { AppShell, PageIntro } from '@/components/app-shell';
import { InlineNotice, LoadingRows, MetricCard, Panel, PanelHeading, QueryState, StatusPill } from '@/components/console-ui';
import { AlertPill, alertTypeLabel, relativeAge, type AlertRecord } from '@/pages/alerts';
import { DeviceSoftware } from '@/pages/software';
import { DeviceProcesses, DeviceServices } from '@/pages/device-runtime';

type Tab = 'overview' | 'performance' | 'hardware' | 'disks' | 'network' | 'software' | 'services' | 'processes' | 'alerts' | 'activity';
type RangeKey = '1H' | '6H' | '24H' | '7D' | '30D' | '90D';
type HistoryPoint = { timestamp: string; cpu_avg: number; cpu_min: number; cpu_max: number; ram_avg: number; ram_min: number; ram_max: number; sample_count: number };
type DiskPoint = { timestamp: string; usage_avg: number; usage_min: number; usage_max: number; usage_latest: number; total_bytes: number; used_bytes: number; free_bytes: number; sample_count: number };
type HistoryResponse = { resolution: 'raw' | 'hour' | 'day'; from: string; to: string; points: HistoryPoint[]; disks: Array<{ volume: string; points: DiskPoint[] }> };
type MonitoringResponse = { status: string; health: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'OFFLINE' | 'UNKNOWN'; downtime: { last_offline_at: string | null; last_recovery_at: string | null; last_completed_outage_seconds: number | null; ongoing_outage_seconds: number | null }; activity: Array<{ id: string; event: string; timestamp: string }> };
type ChartDatum = { timestamp: string; value: number | null };
const rangeMilliseconds: Record<RangeKey, number> = { '1H': 3600000, '6H': 21600000, '24H': 86400000, '7D': 604800000, '30D': 2592000000, '90D': 7776000000 };

async function fetchJson<T>(url: string): Promise<T> { const response = await fetch(url); if (!response.ok) throw new Error(`Request failed (${response.status})`); return response.json() as Promise<T>; }

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
  const monitoringQuery = useQuery({ queryKey: ['device-monitoring', deviceId], enabled: Boolean(deviceId), refetchInterval: 30000, queryFn: () => fetchJson<MonitoringResponse>(`/api/v1/devices/${deviceId}/monitoring`) });
  const alertQuery = useQuery({ queryKey: ['device-alerts', deviceId], enabled: Boolean(deviceId), refetchInterval: 30000, queryFn: () => fetchJson<{ items: AlertRecord[]; total: number }>(`/api/v1/alerts?device_id=${deviceId}&active=true&page_size=25`) });
  const device = deviceQuery.data;

  if (deviceQuery.isLoading) return <AppShell><PageIntro eyebrow="Endpoint detail" title="Loading endpoint" /><Panel><LoadingRows count={5} /></Panel></AppShell>;
  if (deviceQuery.isError || !device) return <AppShell><PageIntro eyebrow="Endpoint detail" title="Endpoint unavailable" /><Panel><QueryState kind="error" onRetry={() => void deviceQuery.refetch()} /></Panel></AppShell>;

  const tabs: { value: Tab; label: string; icon: typeof Cpu }[] = [{ value: 'overview', label: 'Overview', icon: ShieldCheck }, { value: 'performance', label: 'Performance', icon: Gauge }, { value: 'hardware', label: 'Hardware', icon: Cpu }, { value: 'disks', label: 'Disks', icon: HardDrive }, { value: 'network', label: 'Network' , icon: Network }, { value: 'software', label: 'Software', icon: Boxes }, { value: 'services', label: 'Services', icon: ServerCog }, { value: 'processes', label: 'Processes', icon: SquareActivity }, { value: 'alerts', label: `Alerts${alertQuery.data?.total ? ` (${alertQuery.data.total})` : ''}`, icon: Bell }, { value: 'activity', label: 'Activity', icon: Wifi }];
  return <AppShell><div className="mb-4 flex items-center gap-2 text-[11px] text-muted-foreground"><Link href="/devices" className="inline-flex items-center gap-1 transition-colors hover:text-primary" data-testid="link-back-devices"><ArrowLeft size={13} /> Devices</Link><ChevronRight size={13} /><span className="font-mono-data text-primary">{device.hostname}</span></div><PageIntro eyebrow="Endpoint detail" title={device.hostname} description={`${device.os_name || 'Windows endpoint'}${device.os_build ? ` · ${device.os_build}` : ''} · Agent ${device.agent_version || 'version unavailable'}`} action={<div className="flex items-center gap-3"><StatusPill status={device.status} /><button type="button" onClick={() => { void deviceQuery.refetch(); void monitoringQuery.refetch(); }} className="rounded-md border border-border bg-card p-2 text-muted-foreground transition-colors hover:border-accent hover:text-primary" aria-label="Refresh endpoint" data-testid="button-refresh-device"><RefreshCw size={15} className={deviceQuery.isFetching ? 'animate-spin' : ''} /></button></div>} />
    {device.status !== 'ONLINE' && <div className="mb-5"><InlineNotice tone={device.status === 'OFFLINE' ? 'red' : 'amber'}>{device.status === 'OFFLINE' ? 'This endpoint is not responding. Values below reflect the last inventory received.' : 'This endpoint has not established a current state yet. Treat live metrics as provisional.'}</InlineNotice></div>}
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-border"><div className="flex min-w-max gap-1">{tabs.map((item) => { const Icon = item.icon; return <button type="button" key={item.value} onClick={() => setTab(item.value)} className={`flex items-center gap-2 border-b-2 px-3 py-3 text-[11px] font-semibold transition-colors ${tab === item.value ? 'border-accent text-primary' : 'border-transparent text-muted-foreground hover:text-primary'}`} data-testid={`tab-device-${item.value}`}><Icon size={14} />{item.label}</button>; })}</div></div>
    {tab === 'overview' && <OverviewTab device={device} monitoring={monitoringQuery.data} />}
    {tab === 'performance' && <PerformanceTab deviceId={deviceId} />}
    {tab === 'hardware' && <HardwareTab hardware={device.hardware} device={device} />}
    {tab === 'disks' && <DisksTab disks={device.disks} />}
    {tab === 'network' && <NetworkTab network={device.network} />}
    {tab === 'software' && <DeviceSoftware deviceId={deviceId} />}
    {tab === 'services' && <DeviceServices deviceId={deviceId} />}
    {tab === 'processes' && <DeviceProcesses deviceId={deviceId} />}
    {tab === 'alerts' && <DeviceAlertsTab alerts={alertQuery.data?.items ?? []} loading={alertQuery.isLoading} />}
    {tab === 'activity' && <ActivityTab events={monitoringQuery.data?.activity ?? []} loading={monitoringQuery.isLoading} hostname={device.hostname} />}
  </AppShell>;
}

function OverviewTab({ device, monitoring }: { device: DeviceDetails; monitoring?: MonitoringResponse }) {
  const identityRows: Array<[string, string, typeof UserRound]> = [
    ['Current user', device.current_user || 'Not reported', UserRound],
    ['Domain', device.domain || 'Not joined', ShieldCheck],
    ['IP address', device.ip_address || 'Not reported', Network],
    ['Architecture', device.architecture || 'Not reported', Cpu],
  ];
  const healthTone = monitoring?.health === 'CRITICAL' || monitoring?.health === 'OFFLINE' ? 'red' : monitoring?.health === 'WARNING' ? 'amber' : 'mint';
  return <><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"><MetricCard label="Health" value={formatHealth(monitoring?.health)} detail="Recent 5-sample window" tone={healthTone} /><MetricCard label="CPU utilization" value={formatPercent(device.cpu_percent)} detail="Latest sample" tone="navy" /><MetricCard label="Memory utilization" value={formatPercent(device.ram_percent)} detail="Latest sample" tone="mint" /><MetricCard label="Highest disk" value={formatPercent(device.disk_percent)} detail="Latest sample" tone={(device.disk_percent ?? 0) >= 85 ? 'amber' : 'navy'} /><MetricCard label="Uptime" value={uptime(device.uptime_seconds)} detail="Since last reboot" tone="navy" /></div><div className="mt-5 grid gap-5 xl:grid-cols-[1fr_1fr]"><Panel><PanelHeading eyebrow="Identity" title="Endpoint profile" /><div className="divide-y divide-border/60 px-5">{identityRows.map(([label, value, Icon]) => <div key={label} className="flex items-center gap-3 py-3.5"><Icon size={15} className="text-muted-foreground" /><div className="min-w-0"><p className="text-[10px] text-muted-foreground">{label}</p><p className="truncate text-[12px] font-semibold text-primary">{value}</p></div></div>)}</div></Panel><Panel><PanelHeading eyebrow="Availability" title="Latest downtime" /><div className="grid gap-px bg-border/60 sm:grid-cols-2"><InfoCell label="Last offline" value={formatDate(monitoring?.downtime.last_offline_at)} /><InfoCell label="Last recovery" value={formatDate(monitoring?.downtime.last_recovery_at)} /><InfoCell label="Completed outage" value={formatDuration(monitoring?.downtime.last_completed_outage_seconds)} /><InfoCell label="Ongoing outage" value={monitoring?.downtime.ongoing_outage_seconds == null ? 'None' : formatDuration(monitoring.downtime.ongoing_outage_seconds)} /></div></Panel></div></>;
}

function PerformanceTab({ deviceId }: { deviceId: string }) {
  const [range, setRange] = useState<RangeKey>('1H');
  const query = useQuery({ queryKey: ['device-history', deviceId, range], refetchInterval: range === '1H' ? 30000 : false, queryFn: () => { const to = new Date(); const from = new Date(to.getTime() - rangeMilliseconds[range]); return fetchJson<HistoryResponse>(`/api/v1/devices/${deviceId}/metrics?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&resolution=auto`); } });
  const [selectedVolume, setSelectedVolume] = useState<string>();
  const data = query.data;
  const volume = data?.disks.some((disk) => disk.volume === selectedVolume) ? selectedVolume : data?.disks[0]?.volume;
  const disk = data?.disks.find((item) => item.volume === volume);
  const cpuData = withGaps(data?.points.map((point) => ({ timestamp: point.timestamp, value: point.cpu_avg })) ?? [], data?.resolution);
  const memoryData = withGaps(data?.points.map((point) => ({ timestamp: point.timestamp, value: point.ram_avg })) ?? [], data?.resolution);
  const diskData = withGaps(disk?.points.map((point) => ({ timestamp: point.timestamp, value: point.usage_avg })) ?? [], data?.resolution);
  const memoryValues = data?.points.map((point) => point.ram_avg) ?? [];
  return <div className="space-y-5"><div className="flex justify-end"><div className="flex gap-1 rounded-md border border-border bg-card p-1">{(Object.keys(rangeMilliseconds) as RangeKey[]).map((value) => <button key={value} type="button" onClick={() => setRange(value)} className={`h-8 min-w-10 rounded px-2 text-[10px] font-bold ${range === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>{value}</button>)}</div></div>{query.isLoading ? <Panel><LoadingRows count={5} /></Panel> : query.isError ? <Panel><QueryState kind="error" onRetry={() => void query.refetch()} /></Panel> : <><HistoryPanel title="CPU usage" meta={`${data?.points.length ?? 0} ${data?.resolution ?? 'raw'} points`} data={cpuData} color="#203a52" /><HistoryPanel title="Memory usage" meta={memoryValues.length ? `Current ${memoryValues.at(-1)!.toFixed(1)}% · Average ${(memoryValues.reduce((sum, value) => sum + value, 0) / memoryValues.length).toFixed(1)}% · Peak ${Math.max(...memoryValues).toFixed(1)}%` : undefined} data={memoryData} color="#22a976" /><Panel><PanelHeading eyebrow="Storage performance" title="Disk usage" action={data?.disks.length ? <div className="flex gap-1">{data.disks.map((item) => <button key={item.volume} type="button" onClick={() => setSelectedVolume(item.volume)} className={`h-7 rounded px-2 text-[10px] font-bold ${volume === item.volume ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>{item.volume}</button>)}</div> : undefined} />{diskData.length ? <Chart data={diskData} color="#d59a25" /> : <TelemetryEmpty />}</Panel></>}</div>;
}

function HistoryPanel({ title, meta, data, color }: { title: string; meta?: string; data: ChartDatum[]; color: string }) { return <Panel><PanelHeading eyebrow="Performance history" title={title} meta={meta} />{data.length ? <Chart data={data} color={color} /> : <TelemetryEmpty />}</Panel>; }
function Chart({ data, color }: { data: ChartDatum[]; color: string }) { return <div className="h-64 w-full p-4"><ResponsiveContainer width="100%" height="100%"><LineChart data={data}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="timestamp" tickFormatter={(value) => new Date(String(value)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} minTickGap={30} /><YAxis domain={[0, 100]} width={32} /><Tooltip labelFormatter={(value) => new Date(String(value)).toLocaleString()} formatter={(value) => value == null ? ['No data', 'Usage'] : [`${Number(value).toFixed(1)}%`, 'Usage']} /><Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} connectNulls={false} /></LineChart></ResponsiveContainer></div>; }
function TelemetryEmpty() { return <div className="flex h-64 items-center justify-center text-[11px] text-muted-foreground">No telemetry available for this period</div>; }

function withGaps(points: ChartDatum[], resolution?: HistoryResponse['resolution']): ChartDatum[] {
  const expected = resolution === 'day' ? 86400000 : resolution === 'hour' ? 3600000 : 30000;
  const result: ChartDatum[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous && new Date(point.timestamp).getTime() - new Date(previous.timestamp).getTime() > expected * 2.5) result.push({ timestamp: new Date((new Date(previous.timestamp).getTime() + new Date(point.timestamp).getTime()) / 2).toISOString(), value: null });
    result.push(point);
  }
  return result;
}

function InfoCell({ label, value }: { label: string; value: string }) { return <div className="bg-card px-5 py-4"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 text-[12px] font-semibold text-primary">{value}</p></div>; }
function formatPercent(value?: number | null) { return value == null ? '—' : `${value.toFixed(1)}%`; }
function formatHealth(value?: MonitoringResponse['health']) { return value ? value.charAt(0) + value.slice(1).toLowerCase() : 'Unknown'; }
function formatDate(value?: string | null) { return value ? new Date(value).toLocaleString() : 'Never'; }
function formatDuration(value?: number | null) { if (value == null) return 'Unavailable'; const hours = Math.floor(value / 3600); const minutes = Math.floor((value % 3600) / 60); return `${hours ? `${hours}h ` : ''}${minutes}m`; }

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

function ActivityTab({ events, loading, hostname }: { events: Array<{ id: string; event: string; timestamp: string }>; loading: boolean; hostname: string }) {
  return <Panel><PanelHeading eyebrow="Event log" title="Endpoint activity" meta="Recent events associated with this device" />{loading ? <LoadingRows count={4} /> : events.length === 0 ? <QueryState kind="empty" /> : <div className="divide-y divide-border/60">{events.map((event) => <div key={event.id} className="flex items-center gap-4 px-5 py-4"><div className="h-2 w-2 rounded-full bg-accent" /><div className="flex-1"><p className="text-[12px] font-semibold text-primary">{event.event.replaceAll('_', ' ')}</p><p className="mt-1 font-mono-data text-[10px] text-muted-foreground">{hostname}</p></div><time className="font-mono-data text-[10px] text-muted-foreground">{new Date(event.timestamp).toLocaleString()}</time></div>)}</div>}</Panel>;
}

function DeviceAlertsTab({ alerts, loading }: { alerts: AlertRecord[]; loading: boolean }) {
  return <Panel><PanelHeading eyebrow="Alert lifecycle" title="Active alerts" meta="Open and acknowledged incidents for this endpoint" />{loading ? <LoadingRows count={4} /> : alerts.length === 0 ? <div className="flex min-h-56 items-center justify-center text-[11px] text-muted-foreground">No active alerts</div> : <div className="divide-y divide-border">{alerts.map((alert) => <Link href="/alerts" key={alert.id} className="flex items-center gap-4 px-5 py-4 hover:bg-muted/45"><AlertPill value={alert.severity} /><div className="min-w-0 flex-1"><p className="text-[12px] font-semibold text-primary">{alertTypeLabel(alert.type)}</p><p className="mt-1 text-[10px] text-muted-foreground">{alert.resource ?? 'Device'} · {alert.state} · {alert.occurrence_count} occurrences</p></div><span className="font-mono-data text-[10px] text-muted-foreground">{relativeAge(alert.last_triggered_at)}</span></Link>)}</div>}</Panel>;
}
