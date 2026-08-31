import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { BellRing, Check, Copy, Download, KeyRound, LockKeyhole, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import { AppShell, PageIntro } from '@/components/app-shell';
import { InlineNotice, Panel, PanelHeading } from '@/components/console-ui';
import { apiRequest } from '@/lib/api';
import { useCapability, useSession } from '@/lib/session';

type TokenRecord = {
  id: string; name: string; organization_id: string; organization_name: string | null;
  site_id: string | null; site_name: string | null; expires_at: string; max_uses: number;
  current_uses: number; created_at: string; revoked_at: string | null; active: boolean; token?: string;
};

type Site = { id: string; name: string; status: string };
type AgentManifest = { product: string; version: string; architecture: string; package: string; packageSha256: string; agentSha256: string; packageSizeBytes: number; publishedAt: string };
type ChannelStatus = { channel: 'telegram' | 'email' | 'webhook'; enabled: boolean; configured: boolean; destination: string | null };
type NotificationStatus = { channels: ChannelStatus[]; worker: { healthy: boolean; last_seen_at: string | null }; queue: { pending: number; failed: number } };
type NotificationRecord = { id: string; channel: string; event_type: string; severity: string | null; state: string; attempt_count: number; max_attempts: number; created_at: string; sent_at: string | null; last_error_code: string | null; last_error_message: string | null; device: { hostname: string | null } | null };

function formatBytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Administration() {
  const { session } = useSession();
  const canManageTokens = useCapability('enrollment-token:manage');
  const canReadTokens = useCapability('enrollment-token:read');
  const canManageNotifications = useCapability('notification:manage');

  const organizations = session?.organizations.filter((organization) => organization.status === 'ACTIVE') ?? [];
  const [form, setForm] = useState({ name: '', organization_id: '', site_id: '', expires_at: '', max_uses: 1 });
  const [sites, setSites] = useState<Site[]>([]);
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [createdToken, setCreatedToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [manifest, setManifest] = useState<AgentManifest | null>(null);
  const [manifestError, setManifestError] = useState(false);
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus | null>(null);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [notificationState, setNotificationState] = useState('');
  const [notificationChannel, setNotificationChannel] = useState('');
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationError, setNotificationError] = useState('');

  useEffect(() => {
    fetch('/downloads/agent-manifest.json')
      .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((data: AgentManifest) => setManifest(data))
      .catch(() => setManifestError(true));
  }, []);

  // Default to the only reachable organization so a single-tenant operator is
  // not forced to choose; the field stays mandatory for everyone else.
  useEffect(() => {
    if (!form.organization_id && organizations.length === 1) {
      setForm((current) => ({ ...current, organization_id: organizations[0]!.id }));
    }
  }, [organizations, form.organization_id]);

  // Sites are re-read whenever the organization changes; a token can only point
  // at a site inside the organization it is issued for.
  useEffect(() => {
    if (!form.organization_id) { setSites([]); return; }
    let cancelled = false;
    apiRequest<{ items: Site[] }>(`/v1/organizations/${form.organization_id}/sites`)
      .then((data) => { if (!cancelled) setSites(data.items.filter((site) => site.status === 'ACTIVE')); })
      .catch(() => { if (!cancelled) setSites([]); });
    return () => { cancelled = true; };
  }, [form.organization_id]);

  const loadTokens = async () => {
    setBusy(true); setError('');
    try { setTokens(await apiRequest<TokenRecord[]>('/v1/admin/enrollment-tokens')); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load tokens.'); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (canReadTokens) void loadTokens(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [canReadTokens]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const created = await apiRequest<TokenRecord>('/v1/admin/enrollment-tokens', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          organization_id: form.organization_id,
          site_id: form.site_id || null,
          expires_at: new Date(form.expires_at).toISOString(),
          max_uses: form.max_uses,
        }),
      });
      setCreatedToken(created.token ?? '');
      setTokens((current) => [created, ...current]);
      setForm((current) => ({ ...current, name: '' }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to create token.'); }
    finally { setBusy(false); }
  };

  const revoke = async (id: string) => {
    setBusy(true); setError('');
    try { await apiRequest(`/v1/admin/enrollment-tokens/${id}/revoke`, { method: 'POST' }); await loadTokens(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to revoke token.'); }
    finally { setBusy(false); }
  };

  const copy = async () => { await navigator.clipboard.writeText(createdToken); setCopied(true); window.setTimeout(() => setCopied(false), 1500); };

  const loadNotifications = async () => {
    setNotificationBusy(true); setNotificationError('');
    try {
      const params = new URLSearchParams({ page: '1', page_size: '25' });
      if (notificationState) params.set('state', notificationState);
      if (notificationChannel) params.set('channel', notificationChannel);
      const requests: [Promise<NotificationStatus | null>, Promise<{ items: NotificationRecord[] }>] = [
        canManageNotifications ? apiRequest<NotificationStatus>('/v1/admin/notification-channels') : Promise.resolve(null),
        apiRequest<{ items: NotificationRecord[] }>(`/v1/notifications?${params}`),
      ];
      const [status, history] = await Promise.all(requests);
      setNotificationStatus(status);
      setNotifications(history.items);
    } catch (reason) { setNotificationError(reason instanceof Error ? reason.message : 'Unable to load notification status.'); }
    finally { setNotificationBusy(false); }
  };

  const sendTest = async (channel: string) => {
    setNotificationBusy(true); setNotificationError('');
    try {
      await apiRequest(`/v1/admin/notification-channels/${channel}/test`, { method: 'POST' });
      window.setTimeout(() => void loadNotifications(), 1200);
    } catch (reason) { setNotificationError(reason instanceof Error ? reason.message : 'Unable to queue test notification.'); setNotificationBusy(false); }
  };

  return <AppShell><PageIntro eyebrow="Workspace controls" title="Administration" description="Issue and revoke endpoint enrollment credentials. Every token is scoped to one organization." />
    <div className="grid gap-5 xl:grid-cols-[.8fr_1.2fr]">
      <Panel><PanelHeading eyebrow="Enrollment" title="Create enrollment token" action={<KeyRound size={17} className="text-accent" />} />
        {!canManageTokens
          ? <div className="p-5"><InlineNotice>Your role does not permit issuing enrollment tokens.</InlineNotice></div>
          : <form onSubmit={create} className="space-y-4 p-5">
              <InlineNotice>Raw tokens are shown once. The organization on this token decides which tenant an enrolling device joins — the agent cannot choose or override it.</InlineNotice>
              <Field label="Organization">
                <select required value={form.organization_id} onChange={(event) => setForm({ ...form, organization_id: event.target.value, site_id: '' })} className="field-control" data-testid="select-token-organization">
                  <option value="">Select an organization…</option>
                  {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
                </select>
              </Field>
              <Field label="Site (optional)">
                <select value={form.site_id} onChange={(event) => setForm({ ...form, site_id: event.target.value })} className="field-control" disabled={!form.organization_id} data-testid="select-token-site">
                  <option value="">Assign later</option>
                  {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
                </select>
              </Field>
              <Field label="Token name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="field-control" placeholder="Finance workstation rollout" data-testid="input-token-name" /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Expires"><input type="datetime-local" required value={form.expires_at} onChange={(event) => setForm({ ...form, expires_at: event.target.value })} className="field-control" /></Field>
                <Field label="Maximum uses"><input type="number" min="1" max="10000" required value={form.max_uses} onChange={(event) => setForm({ ...form, max_uses: Number(event.target.value) })} className="field-control" /></Field>
              </div>
              {error && <InlineNotice tone="red">{error}</InlineNotice>}
              <button disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-[11px] font-bold text-primary-foreground disabled:opacity-50" data-testid="button-create-token">Create token <ShieldCheck size={14} /></button>
            </form>}
        {createdToken && <div className="border-t border-border bg-[#f2fbf6] p-5"><p className="mb-2 text-[11px] font-bold text-[#14704f]">Copy this token now</p><div className="flex gap-2"><code className="min-w-0 flex-1 truncate rounded border bg-card p-2 text-[11px]">{createdToken}</code><button type="button" onClick={() => void copy()} className="rounded border bg-card p-2" aria-label="Copy enrollment token">{copied ? <Check size={14} /> : <Copy size={14} />}</button></div></div>}
      </Panel>

      <Panel><PanelHeading eyebrow="Credentials" title="Enrollment tokens" meta="Raw token values cannot be retrieved after creation." action={<button type="button" onClick={() => void loadTokens()} disabled={busy || !canReadTokens} className="rounded-md border p-2 text-muted-foreground disabled:opacity-40" aria-label="Refresh enrollment tokens"><RefreshCw size={15} className={busy ? 'animate-spin' : ''} /></button>} />
        {!canReadTokens ? <div className="p-8 text-center text-[11px] text-muted-foreground">Your role does not permit viewing enrollment tokens.</div>
          : tokens.length === 0 ? <div className="p-8 text-center text-[11px] text-muted-foreground">No enrollment tokens have been issued for your organizations.</div>
          : <div className="divide-y divide-border">{tokens.map((token) => <div key={token.id} className="flex items-center gap-4 px-5 py-4" data-testid={`row-token-${token.id}`}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-semibold text-primary">{token.name}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {token.organization_name ?? 'Unknown organization'}{token.site_name ? ` · ${token.site_name}` : ''} · {token.current_uses}/{token.max_uses} uses · expires {new Date(token.expires_at).toLocaleString()}
                </p>
              </div>
              <span className={`text-[10px] font-bold ${token.active && !token.revoked_at ? 'text-[#14704f]' : 'text-destructive'}`}>{token.active && !token.revoked_at ? 'ACTIVE' : 'REVOKED'}</span>
              {canManageTokens && token.active && !token.revoked_at && <button type="button" onClick={() => void revoke(token.id)} className="text-[10px] font-bold text-destructive hover:underline">Revoke</button>}
            </div>)}</div>}
      </Panel>
    </div>

    <div className="mt-5 space-y-5">
      <Panel><PanelHeading eyebrow="Delivery operations" title="Notifications" meta="Notification channels are platform-global in this release; delivery history below is scoped to your organizations." action={<button type="button" onClick={() => void loadNotifications()} disabled={notificationBusy} className="rounded-md border p-2 text-muted-foreground disabled:opacity-40" aria-label="Refresh notification status"><RefreshCw size={15} className={notificationBusy ? 'animate-spin' : ''} /></button>} />
        {!notificationStatus ? <div className="p-8 text-center text-[11px] text-muted-foreground">{canManageNotifications ? 'Refresh to load notification channel status.' : 'Channel configuration is managed by platform administrators.'}</div>
          : <div className="grid gap-px bg-border md:grid-cols-3">{notificationStatus.channels.map((channel) => <div key={channel.channel} className="bg-card p-5"><div className="flex items-center justify-between"><p className="text-[12px] font-semibold capitalize text-primary">{channel.channel}</p><span className={`text-[9px] font-bold uppercase ${channel.enabled ? 'text-[#14704f]' : 'text-muted-foreground'}`}>{channel.enabled ? 'Enabled' : channel.configured ? 'Disabled' : 'Not configured'}</span></div><p className="mt-2 truncate text-[10px] text-muted-foreground">{channel.destination ?? 'Server configuration required'}</p><button type="button" disabled={!channel.enabled || notificationBusy} onClick={() => void sendTest(channel.channel)} className="mt-4 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-[10px] font-bold disabled:opacity-35"><Send size={13} />Send test</button></div>)}</div>}
        {notificationStatus && <div className="flex flex-wrap gap-5 border-t border-border px-5 py-3 text-[10px] text-muted-foreground"><span>Worker <strong className={notificationStatus.worker.healthy ? 'text-[#14704f]' : 'text-destructive'}>{notificationStatus.worker.healthy ? 'HEALTHY' : 'UNAVAILABLE'}</strong></span><span>Queued <strong className="text-primary">{notificationStatus.queue.pending}</strong></span><span>Failed <strong className="text-primary">{notificationStatus.queue.failed}</strong></span></div>}
      </Panel>

      <Panel><PanelHeading eyebrow="Audit trail" title="Notification history" action={<BellRing size={17} className="text-muted-foreground" />} />
        <div className="flex gap-3 border-b p-4">
          <select className="field-control max-w-48" value={notificationState} onChange={(event) => setNotificationState(event.target.value)}><option value="">All states</option>{['PENDING','PROCESSING','SENT','RETRY','FAILED','CANCELLED'].map((state) => <option key={state}>{state}</option>)}</select>
          <select className="field-control max-w-48" value={notificationChannel} onChange={(event) => setNotificationChannel(event.target.value)}><option value="">All channels</option>{['telegram','email','webhook'].map((channel) => <option key={channel}>{channel}</option>)}</select>
          <button type="button" disabled={notificationBusy} onClick={() => void loadNotifications()} className="rounded-md border px-3 text-[10px] font-bold disabled:opacity-40">Apply</button>
        </div>
        {notifications.length === 0 ? <div className="p-8 text-center text-[11px] text-muted-foreground">No notification deliveries match the current filters.</div>
          : <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left"><thead><tr className="bg-muted/45 text-[9px] font-bold uppercase text-muted-foreground"><th className="px-4 py-3">Time</th><th className="px-4 py-3">Channel</th><th className="px-4 py-3">Device</th><th className="px-4 py-3">Event</th><th className="px-4 py-3">State</th><th className="px-4 py-3">Attempts</th><th className="px-4 py-3">Result</th></tr></thead><tbody className="divide-y divide-border">{notifications.map((item) => <tr key={item.id} className="text-[10px]"><td className="px-4 py-3 font-mono-data">{new Date(item.created_at).toLocaleString()}</td><td className="px-4 py-3 capitalize">{item.channel}</td><td className="px-4 py-3 font-semibold">{item.device?.hostname ?? 'Test delivery'}</td><td className="px-4 py-3">{item.event_type.replaceAll('_', ' ')}</td><td className="px-4 py-3 font-bold">{item.state}</td><td className="px-4 py-3 font-mono-data">{item.attempt_count}/{item.max_attempts}</td><td className="max-w-64 truncate px-4 py-3 text-muted-foreground" title={item.last_error_message ?? undefined}>{item.last_error_code ?? (item.sent_at ? 'Delivered' : 'Waiting')}</td></tr>)}</tbody></table></div>}
        {notificationError && <div className="p-4"><InlineNotice tone="red">{notificationError}</InlineNotice></div>}
      </Panel>
    </div>

    <div className="mt-5">
      <Panel>
        <PanelHeading eyebrow="Distribution" title="Agent Downloads" meta="Internal Pilot network only. Windows Agent installers are not authenticated downloads." action={<Download size={17} className="text-muted-foreground" />} />
        <div className="p-5">
          {manifestError && <InlineNotice tone="red">Could not load the Agent package manifest. Run the packaging script on the server, then reload.</InlineNotice>}
          {!manifest && !manifestError && <div className="text-[11px] text-muted-foreground">Loading Agent package details…</div>}
          {manifest && (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-primary">Windows Agent</p>
                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[11px] sm:grid-cols-4">
                  <div><dt className="text-muted-foreground">Version</dt><dd className="font-mono-data text-primary">{manifest.version}</dd></div>
                  <div><dt className="text-muted-foreground">Architecture</dt><dd className="font-mono-data text-primary">Windows x64</dd></div>
                  <div><dt className="text-muted-foreground">Package</dt><dd className="font-mono-data text-primary">{manifest.package}</dd></div>
                  <div><dt className="text-muted-foreground">Size</dt><dd className="font-mono-data text-primary">{formatBytes(manifest.packageSizeBytes)}</dd></div>
                </dl>
                <p className="mt-3 truncate text-[10px] text-muted-foreground">SHA-256 (package): <span className="font-mono-data text-primary">{manifest.packageSha256}</span></p>
                <p className="mt-1 truncate text-[10px] text-muted-foreground">SHA-256 (nexora-agent.exe): <span className="font-mono-data text-primary">{manifest.agentSha256}</span></p>
              </div>
              <a href="/downloads/nexora-agent-pilot.zip" download className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md bg-primary px-4 text-[11px] font-bold text-primary-foreground transition-colors hover:bg-[#2e4f68]" data-testid="button-download-agent">
                Download Windows Agent <Download size={14} />
              </a>
            </div>
          )}
        </div>
      </Panel>
    </div>

    <div className="mt-5"><Panel><div className="flex items-center gap-3 p-5 text-[11px] text-muted-foreground"><LockKeyhole size={15} /> Agent credentials are generated independently during enrollment and cannot be retrieved here. The administrative API token is a platform credential and is never held by this console.</div></Panel></div>
  </AppShell>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">{label}</span>{children}</label>;
}
