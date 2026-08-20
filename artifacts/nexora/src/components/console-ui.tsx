import type { HTMLAttributes, ReactNode } from 'react';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Check, ChevronLeft, ChevronRight, Inbox, LoaderCircle, RefreshCw, Search, ServerCrash } from 'lucide-react';

export function Panel({ children, className = '', ...props }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return <section className={`rounded-lg border border-card-border bg-card shadow-xs ${className}`} {...props}>{children}</section>;
}

export function PanelHeading({ eyebrow, title, meta, action }: { eyebrow?: string; title: string; meta?: string; action?: ReactNode }) {
  return <div className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4"><div>{eyebrow && <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{eyebrow}</p>}<h2 className="text-[14px] font-semibold tracking-[-0.02em] text-primary">{title}</h2>{meta && <p className="mt-1 text-[11px] text-muted-foreground">{meta}</p>}</div>{action}</div>;
}

export function MetricCard({ label, value, detail, tone = 'navy', trend }: { label: string; value: string | number; detail: string; tone?: 'navy' | 'mint' | 'amber' | 'red'; trend?: 'up' | 'down' }) {
  const toneClass = { navy: 'text-primary', mint: 'text-[#148d67]', amber: 'text-[#b57504]', red: 'text-destructive' }[tone];
  return <div className="group rounded-lg border border-card-border bg-card p-5 shadow-xs transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-md"><div className="flex items-start justify-between"><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>{trend && (trend === 'up' ? <ArrowUpRight size={15} className="text-[#148d67]" /> : <ArrowDownRight size={15} className="text-destructive" />)}</div><div className={`mt-4 font-mono-data text-[28px] font-bold leading-none ${toneClass}`}>{value}</div><p className="mt-3 text-[11px] text-muted-foreground">{detail}</p></div>;
}

export function StatusPill({ status }: { status: string }) {
  const normalized = status.toUpperCase();
  const styles = normalized === 'ONLINE' ? 'bg-[#d9f5e8] text-[#14704f]' : normalized === 'OFFLINE' ? 'bg-[#fce4df] text-[#ae3e32]' : 'bg-[#fff0cc] text-[#986306]';
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${styles}`} data-testid={`status-${normalized.toLowerCase()}`}><span className={`h-1.5 w-1.5 rounded-full ${normalized === 'ONLINE' ? 'bg-[#1baa77]' : normalized === 'OFFLINE' ? 'bg-[#d44b3f]' : 'bg-[#d5951d]'}`} />{normalized}</span>;
}

export function SearchField({ value, onChange, placeholder = 'Search by hostname, IP, or UUID' }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="relative block"><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input data-testid="input-device-search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-[12px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-accent focus:ring-2 focus:ring-accent/20" /></label>;
}

export function LoadingRows({ count = 5 }: { count?: number }) {
  return <div className="space-y-3 p-5" data-testid="loading-skeleton">{Array.from({ length: count }).map((_, index) => <div key={index} className="flex animate-pulse items-center gap-4"><div className="h-8 w-8 rounded-md bg-muted" /><div className="flex-1 space-y-2"><div className="h-3 w-2/5 rounded bg-muted" /><div className="h-2 w-1/4 rounded bg-muted" /></div><div className="h-3 w-16 rounded bg-muted" /></div>)}</div>;
}

export function QueryState({ kind, onRetry }: { kind: 'loading' | 'error' | 'empty'; onRetry?: () => void }) {
  if (kind === 'loading') return <div className="flex min-h-[230px] items-center justify-center"><LoaderCircle size={22} className="animate-spin text-accent" /></div>;
  if (kind === 'error') return <div className="flex min-h-[230px] flex-col items-center justify-center px-5 text-center"><ServerCrash size={24} className="mb-3 text-destructive" /><p className="text-[13px] font-semibold text-primary">Could not reach the operations feed</p><p className="mt-1 text-[11px] text-muted-foreground">The API did not return a response. Try again in a moment.</p>{onRetry && <button type="button" onClick={onRetry} className="mt-4 inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[11px] font-semibold text-primary transition-colors hover:bg-muted" data-testid="button-retry"><RefreshCw size={13} /> Retry connection</button>}</div>;
  return <div className="flex min-h-[230px] flex-col items-center justify-center px-5 text-center"><Inbox size={25} className="mb-3 text-muted-foreground/60" /><p className="text-[13px] font-semibold text-primary">No records in this view</p><p className="mt-1 text-[11px] text-muted-foreground">As enrolled endpoints report in, their activity will appear here.</p></div>;
}

export function EmptySearch() {
  return <div className="flex flex-col items-center justify-center px-5 py-16 text-center"><Search size={24} className="mb-3 text-muted-foreground/60" /><p className="text-[13px] font-semibold text-primary">No matching endpoints</p><p className="mt-1 text-[11px] text-muted-foreground">Try a different hostname, IP address, or status filter.</p></div>;
}

export function Pagination({ page, pageSize, total, onPageChange }: { page: number; pageSize: number; total: number; onPageChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="flex items-center justify-between border-t border-border/70 px-5 py-3"><p className="text-[11px] text-muted-foreground"><span className="font-mono-data text-primary">{total === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)}</span> of <span className="font-mono-data text-primary">{total}</span> devices</p><div className="flex items-center gap-1"><button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="rounded border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-35" aria-label="Previous page" data-testid="button-previous-page"><ChevronLeft size={14} /></button><span className="min-w-8 text-center font-mono-data text-[11px] text-primary">{page} / {pages}</span><button type="button" disabled={page >= pages} onClick={() => onPageChange(page + 1)} className="rounded border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-35" aria-label="Next page" data-testid="button-next-page"><ChevronRight size={14} /></button></div></div>;
}

export function InlineNotice({ children, tone = 'amber' }: { children: ReactNode; tone?: 'amber' | 'red' | 'mint' }) {
  const styles = tone === 'amber' ? 'border-[#e8c66f]/60 bg-[#fff8e6] text-[#76530a]' : tone === 'red' ? 'border-[#efb1a8] bg-[#fff1ee] text-[#9f3b31]' : 'border-[#9bdcc4] bg-[#e9fbf2] text-[#136d4e]';
  return <div className={`flex items-start gap-2 rounded-md border px-3 py-2.5 text-[11px] ${styles}`}><AlertTriangle size={14} className="mt-0.5 shrink-0" />{children}</div>;
}

export function CheckMark() { return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#d9f5e8] text-[#14704f]"><Check size={12} strokeWidth={3} /></span>; }