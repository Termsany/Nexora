import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Activity,
  Bell,
  Bot,
  Boxes,
  ChevronRight,
  CircleHelp,
  Cpu,
  FileBarChart,
  Laptop,
  LifeBuoy,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  ShieldCheck,
  Ticket,
} from 'lucide-react';

const primaryNav = [
  { href: '/', label: 'Overview', icon: Activity },
  { href: '/devices', label: 'Devices', icon: Laptop },
  { href: '/alerts', label: 'Alerts', icon: Bell, soon: true },
  { href: '/automation', label: 'Automation', icon: Bot, soon: true },
  { href: '/patch-management', label: 'Patch management', icon: ShieldCheck, soon: true },
  { href: '/software', label: 'Software', icon: Boxes, soon: true },
  { href: '/network', label: 'Network', icon: Network, soon: true },
  { href: '/tickets', label: 'Tickets', icon: Ticket, soon: true },
  { href: '/reports', label: 'Reports', icon: FileBarChart, soon: true },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [location] = useLocation();

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[250px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-300 md:translate-x-0 ${collapsed ? 'md:w-[78px]' : ''} ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-[76px] items-center justify-between border-b border-sidebar-border px-5">
          <Link href="/" className={`flex items-center gap-3 ${collapsed ? 'md:mx-auto' : ''}`} data-testid="link-brand">
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground shadow-sm">
              <Cpu size={19} strokeWidth={2.5} />
              <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-sidebar bg-accent animate-pulse-dot" />
            </span>
            <span className={`font-semibold tracking-[-0.03em] text-[18px] ${collapsed ? 'md:hidden' : ''}`}>nexora<span className="text-accent">.</span></span>
          </Link>
          <button type="button" onClick={() => setCollapsed((value) => !value)} className="hidden rounded-md p-2 text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground md:block" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} data-testid="button-toggle-sidebar">
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>

        <div className={`px-4 pt-7 ${collapsed ? 'md:px-3' : ''}`}>
          <p className={`mb-3 px-2 text-[10px] font-bold uppercase tracking-[0.18em] text-sidebar-foreground/40 ${collapsed ? 'md:hidden' : ''}`}>Operations</p>
          <nav className="space-y-1">
            {primaryNav.map((item) => {
              const Icon = item.icon;
              const active = item.href === '/' ? location === '/' : location.startsWith(item.href);
              return (
                <Link key={item.href} href={item.href} onClick={() => setMobileOpen(false)} className={`group flex items-center gap-3 rounded-md px-3 py-2.5 text-[13px] font-medium transition-all ${active ? 'bg-sidebar-primary text-sidebar-primary-foreground shadow-sm' : 'text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground'} ${collapsed ? 'md:justify-center md:px-2' : ''}`} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}>
                  <Icon size={17} strokeWidth={active ? 2.2 : 1.8} />
                  <span className={`${collapsed ? 'md:hidden' : ''} flex-1 truncate`}>{item.label}</span>
                  {item.soon && <span className={`rounded bg-sidebar-foreground/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sidebar-foreground/45 ${collapsed ? 'md:hidden' : ''}`}>Soon</span>}
                  {active && !item.soon && <ChevronRight size={13} className={`${collapsed ? 'md:hidden' : ''} opacity-60`} />}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="mt-auto space-y-4 border-t border-sidebar-border p-4">
          <Link href="/administration" onClick={() => setMobileOpen(false)} className={`group flex items-center gap-3 rounded-md px-3 py-2.5 text-[13px] font-medium transition-colors ${location.startsWith('/administration') ? 'bg-sidebar-accent text-sidebar-foreground' : 'text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground'} ${collapsed ? 'md:justify-center md:px-2' : ''}`} data-testid="link-administration">
            <Settings2 size={17} />
            <span className={`${collapsed ? 'md:hidden' : ''} flex-1`}>Administration</span>
            <ChevronRight size={13} className={collapsed ? 'md:hidden' : ''} />
          </Link>
          <div className={`flex items-center gap-3 rounded-md bg-sidebar-accent/70 p-3 ${collapsed ? 'md:justify-center md:p-2' : ''}`}>
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#c9f3e0] text-[11px] font-bold text-[#173d34]">AR</div>
            <div className={`${collapsed ? 'md:hidden' : ''} min-w-0`}>
              <p className="truncate text-[12px] font-semibold">Alex Rivera</p>
              <p className="truncate text-[10px] text-sidebar-foreground/45">Operations admin</p>
            </div>
            <CircleHelp size={15} className={`ml-auto text-sidebar-foreground/35 ${collapsed ? 'md:hidden' : ''}`} />
          </div>
        </div>
      </aside>
      {mobileOpen && <button type="button" aria-label="Close navigation" onClick={() => setMobileOpen(false)} className="fixed inset-0 z-30 bg-[#07121b]/55 md:hidden" data-testid="button-close-navigation" />}
      <main className={`min-h-[100dvh] transition-[padding] duration-300 md:pl-[250px] ${collapsed ? 'md:pl-[78px]' : ''}`}>
        <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-border/80 bg-background/90 px-5 backdrop-blur-md md:px-8">
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setMobileOpen(true)} className="rounded-md p-2 text-muted-foreground hover:bg-muted md:hidden" aria-label="Open navigation" data-testid="button-open-navigation"><PanelLeftOpen size={19} /></button>
            <div className="hidden items-center gap-2 text-[11px] text-muted-foreground sm:flex">
              <span className="font-mono-data uppercase tracking-[0.12em]">Workspace</span><ChevronRight size={13} />
              <span className="font-medium text-foreground">Northstar IT</span>
            </div>
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            <div className="hidden items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-muted-foreground sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-[#25b77a]" /> API operational</div>
            <button type="button" className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Support" data-testid="button-support"><LifeBuoy size={17} /></button>
            <button type="button" className="relative rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Notifications" data-testid="button-notifications"><Bell size={17} /><span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent" /></button>
            <div className="ml-1 hidden h-7 w-px bg-border sm:block" />
            <span className="hidden font-mono-data text-[10px] text-muted-foreground sm:block">NXR-OPS-01</span>
          </div>
        </header>
        <div className="mx-auto max-w-[1480px] px-5 py-7 md:px-8 lg:px-10">{children}</div>
      </main>
    </div>
  );
}

export function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col justify-between gap-5 md:flex-row md:items-end">
      <div className="animate-rise-in">
        <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-accent" />{eyebrow}</div>
        <h1 className="text-[30px] font-semibold tracking-[-0.045em] text-primary md:text-[38px]">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-[13px] leading-6 text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="animate-rise-in [animation-delay:80ms]">{action}</div>}
    </div>
  );
}