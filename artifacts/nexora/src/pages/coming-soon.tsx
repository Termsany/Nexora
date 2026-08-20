import { useLocation } from 'wouter';
import { ArrowLeft, Clock3, Construction, GitBranch, Lock, Sparkles } from 'lucide-react';
import { AppShell, PageIntro } from '@/components/app-shell';
import { Panel } from '@/components/console-ui';

const pageNames: Record<string, { title: string; description: string; icon: typeof Clock3 }> = {
  '/alerts': { title: 'Alerts', description: 'Signal routing and escalation are being prepared for this workspace.', icon: Sparkles },
  '/automation': { title: 'Automation', description: 'Runbooks and endpoint actions will live here when the service surface is ready.', icon: GitBranch },
  '/patch-management': { title: 'Patch management', description: 'Patch posture and deployment workflows are on the way.', icon: Construction },
  '/software': { title: 'Software', description: 'Application inventory and version posture will appear here.', icon: Lock },
  '/network': { title: 'Network', description: 'Network visibility is queued behind endpoint telemetry.', icon: Clock3 },
  '/tickets': { title: 'Tickets', description: 'Technician work queues will connect here in a future release.', icon: Clock3 },
  '/reports': { title: 'Reports', description: 'Shareable operational snapshots are being assembled.', icon: Clock3 },
};

export default function ComingSoon() {
  const [location, setLocation] = useLocation();
  const page = pageNames[location] ?? pageNames['/alerts'];
  const Icon = page.icon;
  return <AppShell><PageIntro eyebrow="Module status" title={page.title} description={page.description} /><Panel className="grid-lines overflow-hidden"><div className="mx-auto flex min-h-[440px] max-w-xl flex-col items-center justify-center px-6 py-16 text-center"><div className="relative mb-7 flex h-20 w-20 items-center justify-center rounded-2xl border border-accent/45 bg-[#fff6dd] text-[#af7507] shadow-sm"><Icon size={31} strokeWidth={1.5} /><span className="absolute -right-2 -top-2 rounded-full border-4 border-background bg-primary px-2 py-1 text-[8px] font-bold uppercase tracking-[0.12em] text-primary-foreground">Soon</span></div><h2 className="text-xl font-semibold tracking-[-0.035em] text-primary">This surface is not connected yet.</h2><p className="mt-3 max-w-md text-[12px] leading-6 text-muted-foreground">Nexora is keeping this module quiet until the underlying endpoint contract is available. Your current fleet inventory remains fully operational.</p><div className="mt-8 flex flex-wrap justify-center gap-3"><button type="button" onClick={() => setLocation('/')} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-[11px] font-bold text-primary-foreground transition-colors hover:bg-[#2e4f68]" data-testid="button-return-overview"><ArrowLeft size={14} /> Return to overview</button><button type="button" onClick={() => setLocation('/devices')} className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-4 py-2.5 text-[11px] font-bold text-primary transition-colors hover:border-accent hover:bg-[#fffaf0]" data-testid="button-open-inventory">Open inventory</button></div></div></Panel></AppShell>;
}