import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'wouter';
import { ArrowLeft, Laptop, MapPin, Plus, Users, X } from 'lucide-react';
import { AppShell, PageIntro } from '@/components/app-shell';
import { InlineNotice, LoadingRows, MetricCard, Panel, PanelHeading, QueryState, StatusPill } from '@/components/console-ui';
import { useCapability } from '@/lib/session';
import { apiRequest, useApiQuery } from '@/lib/api';
import { OrganizationStatusPill } from '@/pages/organizations';

type OrganizationDetail = {
  id: string; name: string; slug: string; status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  notes: string | null; external_reference: string | null;
  site_count: number; device_count: number; online_device_count: number;
  active_alert_count: number; member_count: number; last_activity_at: string | null;
};

type Site = {
  id: string; organization_id: string; name: string; code: string | null; city: string | null;
  status: 'ACTIVE' | 'ARCHIVED'; device_count?: number;
};

type Member = { id: string; user_id: string; email: string; name: string; role: string; status: string };

type DeviceRow = {
  id: string; hostname: string; status: string; os_name: string | null;
  agent_version: string | null; site_name: string | null; last_seen_at: string | null;
};

const tabs = ['Overview', 'Sites', 'Devices', 'Members'] as const;

export default function OrganizationDetailPage() {
  const params = useParams<{ organizationId: string }>();
  const organizationId = params.organizationId!;
  const [tab, setTab] = useState<(typeof tabs)[number]>('Overview');

  const organization = useApiQuery<OrganizationDetail>(['organization', organizationId], `/v1/organizations/${organizationId}`);

  if (organization.isLoading) return <AppShell><LoadingRows count={4} /></AppShell>;
  if (organization.isError || !organization.data) {
    return <AppShell>
      <PageIntro eyebrow="Tenancy" title="Organization not found" description="This organization does not exist, or it is not one your account can reach." />
      <Link href="/organizations" className="inline-flex items-center gap-2 text-[11px] font-bold text-[#b57504]"><ArrowLeft size={13} /> Back to organizations</Link>
    </AppShell>;
  }
  const data = organization.data;

  return <AppShell>
    <PageIntro
      eyebrow="Organization" title={data.name}
      description={data.notes ?? `Tenant slug ${data.slug}. Device ownership is fixed at enrollment and cannot be changed here.`}
      action={<OrganizationStatusPill status={data.status} />}
    />

    {data.status === 'SUSPENDED' && <div className="mb-5"><InlineNotice>This organization is suspended. New enrollment is blocked and its organization users cannot sign in to it. Existing agents keep reporting so monitoring visibility is retained.</InlineNotice></div>}
    {data.status === 'ARCHIVED' && <div className="mb-5"><InlineNotice>This organization is archived. Its data is retained and new enrollment is prohibited.</InlineNotice></div>}

    <div className="mb-5 flex gap-1 border-b border-border/70">
      {tabs.map((item) => (
        <button
          key={item} type="button" onClick={() => setTab(item)}
          className={`px-4 py-2.5 text-[12px] font-semibold transition-colors ${tab === item ? 'border-b-2 border-accent text-primary' : 'text-muted-foreground hover:text-primary'}`}
          data-testid={`tab-${item.toLowerCase()}`}
        >{item}</button>
      ))}
    </div>

    {tab === 'Overview' && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="Devices" value={data.device_count} detail={`${data.online_device_count} online now`} />
      <MetricCard label="Sites" value={data.site_count} detail="Active locations" />
      <MetricCard label="Active alerts" value={data.active_alert_count} detail="Open or acknowledged" tone={data.active_alert_count > 0 ? 'red' : 'navy'} />
      <MetricCard label="Members" value={data.member_count} detail="Assigned console users" />
    </div>}

    {tab === 'Sites' && <SitesTab organizationId={organizationId} />}
    {tab === 'Devices' && <DevicesTab organizationId={organizationId} />}
    {tab === 'Members' && <MembersTab organizationId={organizationId} />}
  </AppShell>;
}

function SitesTab({ organizationId }: { organizationId: string }) {
  const canManage = useCapability('site:manage', organizationId);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const query = useApiQuery<{ items: Site[] }>(['sites', organizationId], `/v1/organizations/${organizationId}/sites?include_archived=true`);

  const archive = async (site: Site) => {
    setError('');
    try {
      await apiRequest(`/v1/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'ARCHIVED' }) });
      void query.refetch();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not archive the site.'); }
  };

  return <>
    {creating && <CreateSitePanel organizationId={organizationId} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void query.refetch(); }} />}
    <Panel>
      <PanelHeading
        eyebrow="Locations" title="Sites" meta="A site always belongs to this organization. Devices can only be placed in their own organization's sites."
        action={canManage ? <button type="button" onClick={() => setCreating(true)} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-[11px] font-bold text-primary-foreground" data-testid="button-new-site"><Plus size={13} /> New site</button> : <MapPin size={17} className="text-muted-foreground" />}
      />
      {error && <div className="p-4"><InlineNotice tone="red">{error}</InlineNotice></div>}
      {query.isLoading ? <LoadingRows count={3} />
        : query.isError ? <QueryState kind="error" onRetry={() => void query.refetch()} />
        : (query.data?.items.length ?? 0) === 0 ? <QueryState kind="empty" />
        : <div className="overflow-x-auto"><table className="w-full min-w-[640px]">
            <thead><tr className="bg-muted/45 text-left text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              <th className="px-5 py-3">Site</th><th className="px-4 py-3">Code</th><th className="px-4 py-3">City</th><th className="px-4 py-3">Devices</th><th className="px-4 py-3">Status</th><th className="px-4 py-3" />
            </tr></thead>
            <tbody className="divide-y divide-border/60">{query.data!.items.map((site) => <tr key={site.id} data-testid={`row-site-${site.id}`}>
              <td className="px-5 py-4 text-[12px] font-semibold text-primary">{site.name}</td>
              <td className="px-4 py-4 font-mono-data text-[11px] text-muted-foreground">{site.code ?? '—'}</td>
              <td className="px-4 py-4 text-[11px] text-muted-foreground">{site.city ?? '—'}</td>
              <td className="px-4 py-4 font-mono-data text-[11px] text-primary">{site.device_count ?? 0}</td>
              <td className="px-4 py-4"><OrganizationStatusPill status={site.status} /></td>
              <td className="px-4 py-4 text-right">
                {canManage && site.status === 'ACTIVE' && <button type="button" onClick={() => void archive(site)} className="text-[10px] font-bold text-destructive hover:underline" data-testid={`button-archive-site-${site.id}`}>Archive</button>}
              </td>
            </tr>)}</tbody>
          </table></div>}
    </Panel>
  </>;
}

function CreateSitePanel({ organizationId, onClose, onCreated }: { organizationId: string; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ name: '', code: '', city: '', country: '', address: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await apiRequest(`/v1/organizations/${organizationId}/sites`, {
        method: 'POST',
        body: JSON.stringify({ name: form.name, code: form.code || null, city: form.city || null, country: form.country || null, address: form.address || null }),
      });
      onCreated();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create the site.'); }
    finally { setBusy(false); }
  };

  return <Panel className="mb-5">
    <PanelHeading eyebrow="Locations" title="New site" action={<button type="button" onClick={onClose} className="rounded-md border border-border p-2 text-muted-foreground hover:bg-muted" aria-label="Cancel"><X size={14} /></button>} />
    <form onSubmit={submit} className="grid gap-4 p-5 md:grid-cols-3">
      <label className="block"><span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">Name</span>
        <input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="field-control" placeholder="Head Office" data-testid="input-site-name" /></label>
      <label className="block"><span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">Code</span>
        <input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} className="field-control" placeholder="HO" /></label>
      <label className="block"><span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">City</span>
        <input value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} className="field-control" placeholder="Cairo" /></label>
      {error && <div className="md:col-span-3"><InlineNotice tone="red">{error}</InlineNotice></div>}
      <div className="md:col-span-3"><button disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-[11px] font-bold text-primary-foreground disabled:opacity-50" data-testid="button-create-site">Create site</button></div>
    </form>
  </Panel>;
}

function DevicesTab({ organizationId }: { organizationId: string }) {
  const query = useApiQuery<{ items: DeviceRow[]; total: number }>(['organization-devices', organizationId], `/v1/devices?organization_id=${organizationId}&page_size=100`);
  return <Panel>
    <PanelHeading eyebrow="Endpoints" title="Devices" meta="Device organization is assigned at enrollment and is immutable through the device APIs." action={<Laptop size={17} className="text-muted-foreground" />} />
    {query.isLoading ? <LoadingRows count={4} />
      : query.isError ? <QueryState kind="error" onRetry={() => void query.refetch()} />
      : (query.data?.items.length ?? 0) === 0 ? <QueryState kind="empty" />
      : <div className="overflow-x-auto"><table className="w-full min-w-[720px]">
          <thead><tr className="bg-muted/45 text-left text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            <th className="px-5 py-3">Device</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Site</th><th className="px-4 py-3">Operating system</th><th className="px-4 py-3">Agent</th><th className="px-4 py-3">Last seen</th>
          </tr></thead>
          <tbody className="divide-y divide-border/60">{query.data!.items.map((device) => <tr key={device.id} className="group hover:bg-[#fffaf0]">
            <td className="px-5 py-4"><Link href={`/devices/${device.id}`} className="text-[12px] font-semibold text-primary group-hover:text-[#b57504]">{device.hostname}</Link></td>
            <td className="px-4 py-4"><StatusPill status={device.status} /></td>
            <td className="px-4 py-4 text-[11px] text-muted-foreground">{device.site_name ?? 'Unassigned'}</td>
            <td className="px-4 py-4 text-[11px] text-muted-foreground">{device.os_name ?? '—'}</td>
            <td className="px-4 py-4 font-mono-data text-[10px] text-muted-foreground">{device.agent_version ?? '—'}</td>
            <td className="px-4 py-4 font-mono-data text-[10px] text-muted-foreground">{device.last_seen_at ? new Date(device.last_seen_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never'}</td>
          </tr>)}</tbody>
        </table></div>}
  </Panel>;
}

function MembersTab({ organizationId }: { organizationId: string }) {
  const canManage = useCapability('membership:manage', organizationId);
  const query = useApiQuery<{ items: Member[] }>(['members', organizationId], `/v1/organizations/${organizationId}/members`);
  const [error, setError] = useState('');

  const remove = async (member: Member) => {
    setError('');
    try {
      await apiRequest(`/v1/organizations/${organizationId}/members/${member.user_id}`, { method: 'DELETE' });
      void query.refetch();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not remove the member.'); }
  };

  return <Panel>
    <PanelHeading eyebrow="Access" title="Members" meta="Organization users reach only the organizations they are a member of. Accounts themselves are created by platform administrators." action={<Users size={17} className="text-muted-foreground" />} />
    {error && <div className="p-4"><InlineNotice tone="red">{error}</InlineNotice></div>}
    {query.isLoading ? <LoadingRows count={3} />
      : query.isError ? <QueryState kind="error" onRetry={() => void query.refetch()} />
      : (query.data?.items.length ?? 0) === 0 ? <QueryState kind="empty" />
      : <div className="overflow-x-auto"><table className="w-full min-w-[600px]">
          <thead><tr className="bg-muted/45 text-left text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            <th className="px-5 py-3">User</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Account</th><th className="px-4 py-3" />
          </tr></thead>
          <tbody className="divide-y divide-border/60">{query.data!.items.map((member) => <tr key={member.id} data-testid={`row-member-${member.user_id}`}>
            <td className="px-5 py-4"><p className="text-[12px] font-semibold text-primary">{member.name}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{member.email}</p></td>
            <td className="px-4 py-4 text-[11px] font-semibold text-primary">{member.role.replace('ORGANIZATION_', '')}</td>
            <td className="px-4 py-4"><OrganizationStatusPill status={member.status} /></td>
            <td className="px-4 py-4 text-right">{canManage && <button type="button" onClick={() => void remove(member)} className="text-[10px] font-bold text-destructive hover:underline">Remove</button>}</td>
          </tr>)}</tbody>
        </table></div>}
  </Panel>;
}

