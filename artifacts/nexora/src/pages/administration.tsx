import { useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, KeyRound, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { AppShell, PageIntro } from '@/components/app-shell';
import { InlineNotice, Panel, PanelHeading } from '@/components/console-ui';

type TokenRecord = { id: string; name: string; organization: string; expires_at: string; max_uses: number; current_uses: number; created_at: string; revoked_at: string | null; active: boolean; token?: string };

export default function Administration() {
  const [adminToken, setAdminToken] = useState('');
  const [form, setForm] = useState({ name: '', organization: 'Default', expires_at: '', max_uses: 1 });
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [createdToken, setCreatedToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const request = async (path = '', init?: RequestInit) => {
    const response = await fetch(`/api/v1/admin/enrollment-tokens${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, ...init?.headers } });
    if (!response.ok) throw new Error(response.status === 401 ? 'Administrative authorization was rejected.' : `Request failed (${response.status}).`);
    return response.status === 204 ? undefined : response.json();
  };
  const load = async () => { setBusy(true); setError(''); try { setTokens(await request()); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load tokens.'); } finally { setBusy(false); } };
  const create = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { const created = await request('', { method: 'POST', body: JSON.stringify({ ...form, expires_at: new Date(form.expires_at).toISOString() }) }) as TokenRecord; setCreatedToken(created.token ?? ''); setTokens((current) => [created, ...current]); setForm((current) => ({ ...current, name: '' })); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to create token.'); } finally { setBusy(false); } };
  const revoke = async (id: string) => { setBusy(true); setError(''); try { await request(`/${id}/revoke`, { method: 'POST' }); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to revoke token.'); } finally { setBusy(false); } };
  const copy = async () => { await navigator.clipboard.writeText(createdToken); setCopied(true); window.setTimeout(() => setCopied(false), 1500); };

  return <AppShell><PageIntro eyebrow="Workspace controls" title="Administration" description="Issue and revoke endpoint enrollment credentials." />
    <div className="grid gap-5 xl:grid-cols-[.8fr_1.2fr]">
      <Panel><PanelHeading eyebrow="Enrollment" title="Create enrollment token" action={<KeyRound size={17} className="text-accent" />} />
        <form onSubmit={create} className="space-y-4 p-5">
          <InlineNotice>Raw tokens are shown once. Store the token securely and provide it only to the intended installer.</InlineNotice>
          <Field label="Administrative API token"><input type="password" required value={adminToken} onChange={(event) => setAdminToken(event.target.value)} className="field-control" autoComplete="off" /></Field>
          <Field label="Token name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="field-control" placeholder="Finance workstation rollout" /></Field>
          <Field label="Organization"><input required value={form.organization} onChange={(event) => setForm({ ...form, organization: event.target.value })} className="field-control" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Expires"><input type="datetime-local" required value={form.expires_at} onChange={(event) => setForm({ ...form, expires_at: event.target.value })} className="field-control" /></Field><Field label="Maximum uses"><input type="number" min="1" max="10000" required value={form.max_uses} onChange={(event) => setForm({ ...form, max_uses: Number(event.target.value) })} className="field-control" /></Field></div>
          {error && <InlineNotice tone="red">{error}</InlineNotice>}
          <button disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-[11px] font-bold text-primary-foreground disabled:opacity-50">Create token <ShieldCheck size={14} /></button>
        </form>
        {createdToken && <div className="border-t border-border bg-[#f2fbf6] p-5"><p className="mb-2 text-[11px] font-bold text-[#14704f]">Copy this token now</p><div className="flex gap-2"><code className="min-w-0 flex-1 truncate rounded border bg-card p-2 text-[11px]">{createdToken}</code><button type="button" onClick={() => void copy()} className="rounded border bg-card p-2" aria-label="Copy enrollment token">{copied ? <Check size={14} /> : <Copy size={14} />}</button></div></div>}
      </Panel>
      <Panel><PanelHeading eyebrow="Credentials" title="Enrollment tokens" meta="Raw token values cannot be retrieved." action={<button type="button" onClick={() => void load()} disabled={!adminToken || busy} className="rounded-md border p-2 text-muted-foreground disabled:opacity-40" aria-label="Refresh enrollment tokens"><RefreshCw size={15} className={busy ? 'animate-spin' : ''} /></button>} />
        {tokens.length === 0 ? <div className="p-8 text-center text-[11px] text-muted-foreground">Enter the administrative token and refresh to load credentials.</div> : <div className="divide-y divide-border">{tokens.map((token) => <div key={token.id} className="flex items-center gap-4 px-5 py-4"><div className="min-w-0 flex-1"><p className="truncate text-[12px] font-semibold text-primary">{token.name}</p><p className="mt-1 text-[10px] text-muted-foreground">{token.organization} · {token.current_uses}/{token.max_uses} uses · expires {new Date(token.expires_at).toLocaleString()}</p></div><span className={`text-[10px] font-bold ${token.active && !token.revoked_at ? 'text-[#14704f]' : 'text-destructive'}`}>{token.active && !token.revoked_at ? 'ACTIVE' : 'REVOKED'}</span>{token.active && !token.revoked_at && <button type="button" onClick={() => void revoke(token.id)} className="text-[10px] font-bold text-destructive hover:underline">Revoke</button>}</div>)}</div>}
      </Panel>
    </div>
    <div className="mt-5"><Panel><div className="flex items-center gap-3 p-5 text-[11px] text-muted-foreground"><LockKeyhole size={15} /> Agent credentials are generated independently during enrollment and cannot be retrieved here.</div></Panel></div>
  </AppShell>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block"><span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.13em] text-muted-foreground">{label}</span>{children}</label>; }
