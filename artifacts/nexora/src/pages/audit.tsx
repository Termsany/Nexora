import { useApiQuery } from '@/lib/api';
import { PageIntro, AppShell } from '@/components/app-shell';

type AuditRow = { id: string; occurredAt: string; actorLabel?: string | null; actorType: string; organizationId?: string | null; action: string; targetType?: string | null; targetId?: string | null; result: string; metadata?: Record<string, unknown> | null };
type AuditResponse = { items: AuditRow[]; total: number; page: number; page_size: number };

export default function Audit() {
  const { data, isLoading, error } = useApiQuery<AuditResponse>(['audit'], '/v1/audit?page=1&page_size=50');
  return <AppShell><PageIntro eyebrow="Security" title="Audit log" description="Security and administrative activity with tenant-scoped visibility." />
    <section className="overflow-hidden rounded-md border border-border bg-card">
      {isLoading && <div className="p-8 text-sm text-muted-foreground">Loading audit events...</div>}
      {error && <div className="p-8 text-sm text-destructive">Unable to load audit events.</div>}
      {!isLoading && !error && <table className="w-full text-left text-xs"><thead className="border-b border-border bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground"><tr><th className="px-4 py-3">Time</th><th className="px-4 py-3">Actor</th><th className="px-4 py-3">Action</th><th className="px-4 py-3">Target</th><th className="px-4 py-3">Result</th></tr></thead><tbody>{(data?.items ?? []).map((row) => <tr key={row.id} className="border-b border-border/60 last:border-0"><td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{new Date(row.occurredAt).toLocaleString()}</td><td className="px-4 py-3">{row.actorLabel ?? row.actorType}</td><td className="px-4 py-3 font-medium">{row.action}</td><td className="px-4 py-3 text-muted-foreground">{row.targetType ?? '-'}{row.targetId ? ` · ${row.targetId.slice(0, 8)}` : ''}</td><td className="px-4 py-3">{row.result}</td></tr>)}</tbody></table>}
      {!isLoading && !error && !(data?.items.length) && <div className="p-8 text-sm text-muted-foreground">No audit events found.</div>}
    </section>
  </AppShell>;
}
