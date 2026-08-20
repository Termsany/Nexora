import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ChevronDown, Filter, Laptop, RotateCcw } from 'lucide-react';
import { getListDevicesQueryKey, useListDevices, type ListDevicesParams } from '@workspace/api-client-react';
import { AppShell, PageIntro } from '@/components/app-shell';
import { EmptySearch, LoadingRows, Pagination, Panel, PanelHeading, QueryState, SearchField, StatusPill } from '@/components/console-ui';

const statuses = ['ALL', 'ONLINE', 'OFFLINE', 'UNKNOWN'] as const;

function formatUptime(seconds?: number | null) {
  if (!seconds) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export default function Devices() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<(typeof statuses)[number]>('ALL');
  const [page, setPage] = useState(1);
  const pageSize = 8;
  useEffect(() => { setPage(1); }, [search, status]);
  const params: ListDevicesParams = { search: search || undefined, status: status === 'ALL' ? undefined : status, page, page_size: pageSize };
  const devicesQuery = useListDevices(params, { query: { queryKey: getListDevicesQueryKey(params) } });
  const data = devicesQuery.data;
  const items = data?.items ?? [];
  const showingEmptySearch = !devicesQuery.isLoading && !devicesQuery.isError && items.length === 0 && Boolean(search);

  return <AppShell><PageIntro eyebrow="Endpoint inventory" title="Devices" description="Search, filter, and inspect every enrolled Windows endpoint." action={<div className="flex items-center gap-2 text-[11px] text-muted-foreground"><span className="h-2 w-2 rounded-full bg-[#22a976]" /> Inventory syncs continuously</div>} />
    <Panel>
      <div className="flex flex-col gap-3 border-b border-border/70 p-4 md:flex-row md:items-center md:justify-between">
        <div className="w-full max-w-[480px]"><SearchField value={search} onChange={setSearch} /></div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground"><Filter size={14} /> State</div>
          <div className="relative"><select value={status} onChange={(event) => setStatus(event.target.value as (typeof statuses)[number])} className="h-10 appearance-none rounded-md border border-input bg-background pl-3 pr-8 text-[11px] font-semibold text-primary outline-none transition-colors focus:border-accent" data-testid="select-device-status">{statuses.map((option) => <option key={option} value={option}>{option === 'ALL' ? 'All states' : option}</option>)}</select><ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" /></div>
          {(search || status !== 'ALL') && <button type="button" onClick={() => { setSearch(''); setStatus('ALL'); }} className="inline-flex h-10 items-center gap-1 rounded-md px-2.5 text-[11px] font-semibold text-muted-foreground hover:bg-muted hover:text-primary" data-testid="button-clear-filters"><RotateCcw size={13} /> Reset</button>}
        </div>
      </div>
      {devicesQuery.isLoading ? <LoadingRows count={6} /> : devicesQuery.isError ? <QueryState kind="error" onRetry={() => void devicesQuery.refetch()} /> : items.length === 0 ? (showingEmptySearch ? <EmptySearch /> : <QueryState kind="empty" />) : <div className="scrollbar-thin overflow-x-auto"><table className="w-full min-w-[850px] border-collapse"><thead><tr className="bg-muted/45 text-left text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground"><th className="px-5 py-3">Endpoint</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Operating system</th><th className="px-4 py-3">Utilization</th><th className="px-4 py-3">Uptime</th><th className="px-4 py-3">Last seen</th><th className="px-4 py-3" /></tr></thead><tbody className="divide-y divide-border/60">{items.map((device) => <tr key={device.id} className="group transition-colors hover:bg-[#fffaf0]" data-testid={`row-device-${device.id}`}><td className="px-5 py-4"><Link href={`/devices/${device.id}`} className="flex items-center gap-3" data-testid={`link-device-${device.id}`}><div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground"><Laptop size={15} /></div><div><p className="text-[12px] font-semibold text-primary group-hover:text-[#b57504]">{device.hostname}</p><p className="mt-0.5 font-mono-data text-[9px] text-muted-foreground">{device.ip_address || device.device_uuid.slice(0, 16)}</p></div></Link></td><td className="px-4 py-4"><StatusPill status={device.status} /></td><td className="px-4 py-4"><p className="max-w-[180px] truncate text-[11px] font-medium text-primary">{device.os_name || 'Windows endpoint'}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{device.os_build || device.architecture || 'Build unavailable'}</p></td><td className="px-4 py-4"><div className="flex items-center gap-3 text-[10px] text-muted-foreground"><span className="w-12">CPU <b className="font-mono-data font-normal text-primary">{device.cpu_percent == null ? '—' : `${device.cpu_percent.toFixed(0)}%`}</b></span><span className="w-12">RAM <b className="font-mono-data font-normal text-primary">{device.ram_percent == null ? '—' : `${device.ram_percent.toFixed(0)}%`}</b></span></div></td><td className="px-4 py-4 font-mono-data text-[10px] text-muted-foreground">{formatUptime(device.uptime_seconds)}</td><td className="px-4 py-4 font-mono-data text-[10px] text-muted-foreground">{device.last_seen_at ? new Date(device.last_seen_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never'}</td><td className="px-4 py-4 text-right"><Link href={`/devices/${device.id}`} className="text-[11px] font-bold text-[#b57504] opacity-0 transition-opacity group-hover:opacity-100" data-testid={`link-inspect-device-${device.id}`}>Inspect</Link></td></tr>)}</tbody></table></div>}
      {!devicesQuery.isLoading && !devicesQuery.isError && data && data.total > 0 && <Pagination page={data.page} pageSize={data.page_size} total={data.total} onPageChange={setPage} />}
    </Panel>
  </AppShell>;
}