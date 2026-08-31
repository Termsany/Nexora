import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { Building2, Filter, Plus, X } from 'lucide-react';
import { AppShell, PageIntro } from '@/components/app-shell';
import { EmptySearch, InlineNotice, LoadingRows, Pagination, Panel, PanelHeading, QueryState, SearchField } from '@/components/console-ui';
import { useCapability } from '@/lib/session';
import { apiRequest, useApiQuery } from '@/lib/api';

type OrganizationSummary = {
  id: string; name: string; slug: string; status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  site_count: number; device_count: number; online_device_count: number;
  active_alert_count: number; last_activity_at: string | null;
};

type OrganizationPage = { items: OrganizationSummary[]; page: number; page_size: number; total: number };

const statuses = ['ALL', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;

export function OrganizationStatusPill({ status }: { status: string }) {
  const styles = status === 'ACTIVE' ? 'bg-[#d9f5e8] text-[#14704f]'
    : status === 'SUSPENDED' ? 'bg-[#fff0cc] text-[#986306]'
    : 'bg-muted text-muted-foreground';
  return <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${styles}`}>{status}</span>;
}

function slugify(name: string) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

export default function Organizations() {
  const canCreate = useCapability('organization:create');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<(typeof statuses)[number]>('ALL');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const pageSize = 10;
  useEffect(() => { setPage(1); }, [search, status]);

  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (search) params.set('search', search);
  if (status !== 'ALL') params.set('status', status);
  const query = useApiQuery<OrganizationPage>(['organizations', params.toString()], `/v1/organizations?${params}`);

  const items = query.data?.items ?? [];
  const emptySearch = !query.isLoading && !query.isError && items.length === 0 && Boolean(search);

  return <AppShell>
    <PageIntro
      eyebrow="Tenancy" title="Organizations"
      description="Every managed device belongs to exactly one organization. Organizations are archived, never deleted, so history is preserved."
      action={canCreate ? <button type="button" onClick={() => setCreating(true)} className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-[11px] font-bold text-primary-foreground transition-colors hover:bg-[#2e4f68]" data-testid="button-new-organization"><Plus size={14} /> New organization</button> : undefined}
    />

    {creating && <CreateOrganizationPanel onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void query.refetch(); }} />}

    <Panel>
      <div className="flex flex-col gap-3 border-b border-border/70 p-4 md:flex-row md:items-center md:justify-between">
        <div className="w-full max-w-[420px]"><SearchField value={search} onChange={setSearch} placeholder="Search by organization name or slug" /></div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground"><Filter size={14} /> Status</div>
          <select value={status} onChange={(event) => setStatus(event.target.value as (typeof statuses)[number])} className="h-10 rounded-md border border-input bg-background px-3 text-[11px] font-semibold text-primary outline-none focus:border-accent" data-testid="select-organization-status">
            {statuses.map((option) => <option key={option} value={option}>{option === 'ALL' ? 'All statuses' : option}</option>)}
          </select>
        </div>
      </div>

      {query.isLoading ? <LoadingRows count={5} />
        : query.isError ? <QueryState kind="error" onRetry={() => void query.refetch()} />
        : items.length === 0 ? (emptySearch ? <EmptySearch /> : <QueryState kind="empty" />)
        : <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse">
              <thead><tr className="bg-muted/45 text-left text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                <th className="px-5 py-3">Organization</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Sites</th>
                <th className="px-4 py-3">Devices</th><th className="px-4 py-3">Active alerts</th><th className="px-4 py-3">Last activity</th><th className="px-4 py-3" />
              </tr></thead>
              <tbody className="divide-y divide-border/60">
                {items.map((organization) => <tr key={organization.id} className="group transition-colors hover:bg-[#fffaf0]" data-testid={`row-organization-${organization.id}`}>
                  <td className="px-5 py-4">
                    <Link href={`/organizations/${organization.id}`} className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground"><Building2 size={15} /></div>
                      <div>
                        <p className="text-[12px] font-semibold text-primary group-hover:text-[#b57504]">{organization.name}</p>
                        <p className="mt-0.5 font-mono-data text-[9px] text-muted-foreground">{organization.slug}</p>
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-4"><OrganizationStatusPill status={organization.status} /></td>
                  <td className="px-4 py-4 font-mono-data text-[11px] text-primary">{organization.site_count}</td>
                  <td className="px-4 py-4 text-[11px] text-muted-foreground">
                    <span className="font-mono-data text-primary">{organization.device_count}</span>
                    <span className="ml-1.5">({organization.online_device_count} online)</span>
                  </td>
                  <td className="px-4 py-4 font-mono-data text-[11px]"><span className={organization.active_alert_count > 0 ? 'text-destructive' : 'text-muted-foreground'}>{organization.active_alert_count}</span></td>
                  <td className="px-4 py-4 font-mono-data text-[10px] text-muted-foreground">{organization.last_activity_at ? new Date(organization.last_activity_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never'}</td>
                  <td className="px-4 py-4 text-right"><Link href={`/organizations/${organization.id}`} className="text-[11px] font-bold text-[#b57504] opacity-0 transition-opacity group-hover:opacity-100">Open</Link></td>
                </tr>)}
              </tbody>
            </table>
          </div>}
      {query.data && query.data.total > 0 && <Pagination page={query.data.page} pageSize={query.data.page_size} total={query.data.total} onPageChange={setPage} />}
    </Panel>
  </AppShell>;
}

function CreateOrganizationPanel({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await apiRequest('/v1/organizations', { method: 'POST', body: JSON.stringify({ name, slug: slug || slugify(name), notes: notes || null }) });
      onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the organization.');
    } finally { setBusy(false); }
  };

  return <Panel className="mb-5">
    <PanelHeading eyebrow="Tenancy" title="New organization" action={<button type="button" onClick={onClose} className="rounded-md border border-border p-2 text-muted-foreground hover:bg-muted" aria-label="Cancel"><X size={14} /></button>} />
    <form onSubmit={submit} className="grid gap-4 p-5 md:grid-cols-2">
      <label className="block">
        <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">Name</span>
        <input required value={name} onChange={(event) => { setName(event.target.value); if (!slugTouched) setSlug(slugify(event.target.value)); }} className="field-control" placeholder="Acme Engineering" data-testid="input-organization-name" />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">Slug</span>
        <input required value={slug} onChange={(event) => { setSlugTouched(true); setSlug(event.target.value); }} className="field-control font-mono-data" placeholder="acme-engineering" data-testid="input-organization-slug" />
      </label>
      <label className="block md:col-span-2">
        <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">Notes</span>
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} className="field-control" />
      </label>
      {error && <div className="md:col-span-2"><InlineNotice tone="red">{error}</InlineNotice></div>}
      <div className="md:col-span-2">
        <button disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-[11px] font-bold text-primary-foreground disabled:opacity-50" data-testid="button-create-organization">Create organization</button>
      </div>
    </form>
  </Panel>;
}
