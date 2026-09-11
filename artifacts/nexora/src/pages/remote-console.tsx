import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, Maximize2, Monitor, PowerOff, ScanLine } from 'lucide-react';
import { AppShell, PageIntro } from '@/components/app-shell';
import { InlineNotice, Panel, PanelHeading } from '@/components/console-ui';
import { apiRequest } from '@/lib/api';
import { useCapability } from '@/lib/session';

/**
 * Nexora Remote Console.
 *
 * The viewport is a canvas fed by JPEG frames arriving over the session
 * WebSocket. Input is sent as normalised 0..1 coordinates so the Agent maps to
 * its own pixels and the console never needs to know the remote resolution to
 * stay accurate while scaled.
 *
 * The viewer token lives in component state only. It is never written to
 * localStorage or the URL bar, and it dies with the page.
 */

type DeviceDetails = {
  id: string; hostname: string; status: string; agent_version?: string | null;
  organization_id: string; organization_name?: string | null; site_id?: string | null; site_name?: string | null;
};
type RemoteState = {
  device_id: string; remote_desktop_enabled: boolean; agent_supports_remote_desktop: boolean;
  device_status: string; agent_version: string | null; active_session_id: string | null;
};
type SessionView = { id: string; status: string; expires_at: string; screen_width: number | null; screen_height: number | null };
type CreateResponse = { session: SessionView; privileged_action_id: string; viewer_token: string };

type Phase = 'idle' | 'requesting' | 'awaiting_approval' | 'connecting' | 'live' | 'closed' | 'error';

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Not connected', requesting: 'Requesting session', awaiting_approval: 'Waiting for approval',
  connecting: 'Connecting', live: 'Connected', closed: 'Disconnected', error: 'Error',
};

export default function RemoteConsole() {
  const { deviceId } = useParams<{ deviceId: string }>();
  const canRequest = useCapability('privileged_actions.request');

  const deviceQuery = useQuery({ queryKey: ['device', deviceId], queryFn: () => apiRequest<DeviceDetails>(`/v1/devices/${deviceId}`), retry: false });
  const remoteQuery = useQuery({
    queryKey: ['device-remote-desktop', deviceId],
    queryFn: () => apiRequest<RemoteState>(`/v1/devices/${deviceId}/remote-desktop`),
    retry: false, refetchInterval: 15000,
  });

  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState<string>();
  const [session, setSession] = useState<{ id: string; token: string; expiresAt: string } | null>(null);
  const [screen, setScreen] = useState<{ width: number; height: number } | null>(null);
  const [fit, setFit] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pressedKeys = useRef(new Set<string>());

  const device = deviceQuery.data;
  const remote = remoteQuery.data;

  // ---------------------------------------------------------------- refusals
  const blocked = useMemo(() => {
    if (!remote) return null;
    if (!canRequest) return 'You do not have permission to start a remote session.';
    if (!remote.remote_desktop_enabled) return 'Remote Desktop is disabled for this device.';
    if (!remote.agent_supports_remote_desktop) return 'Agent does not support Remote Desktop.';
    if (remote.device_status !== 'ONLINE') return 'Device is offline.';
    if (remote.active_session_id) return 'This device already has an active remote session.';
    return null;
  }, [remote, canRequest]);

  // ------------------------------------------------------------ frame paint
  const paint = useCallback(async (payload: ArrayBuffer) => {
    const canvas = canvasRef.current;
    if (!canvas || payload.byteLength <= 4) return;
    // 4-byte big-endian sequence header, then the encoded image.
    const image = payload.slice(4);
    try {
      const bitmap = await createImageBitmap(new Blob([image], { type: 'image/jpeg' }));
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width; canvas.height = bitmap.height;
      }
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close();
    } catch { /* a corrupt frame is dropped; the next one repaints */ }
  }, []);

  // --------------------------------------------------------------- teardown
  const disconnect = useCallback((reason?: string) => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: 'session.close' })); } catch { /* closing anyway */ }
    }
    try { socket?.close(); } catch { /* already gone */ }
    pressedKeys.current.clear();
    setPhase('closed');
    if (reason) setNotice(reason);
  }, []);

  useEffect(() => () => { try { socketRef.current?.close(); } catch { /* unmount */ } }, []);

  // Session timer, purely cosmetic but it makes an open session visible.
  useEffect(() => {
    if (phase !== 'live') return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  // ------------------------------------------------------------ open socket
  const openSocket = useCallback((sessionId: string, token: string) => {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/api/v1/remote-desktop/sessions/${sessionId}/viewer?token=${encodeURIComponent(token)}`);
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    setPhase('connecting');

    socket.onopen = () => socket.send(JSON.stringify({ type: 'session.hello', protocol: 'nexora-remote-desktop-v1' }));
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) { void paint(event.data); setPhase('live'); return; }
      let message: { type: string; [key: string]: unknown };
      try { message = JSON.parse(String(event.data)); } catch { return; }
      switch (message.type) {
        case 'session.accepted': setNotice(undefined); break;
        case 'desktop.info': setScreen({ width: Number(message.width), height: Number(message.height) }); break;
        case 'session.status': if (message.state === 'ACTIVE') setPhase('live'); break;
        case 'session.error': setNotice(`Session error: ${String(message.code).replaceAll('_', ' ')}`); break;
        case 'session.rejected': setNotice(`Rejected: ${String(message.reason).replaceAll('_', ' ')}`); setPhase('error'); break;
        case 'session.closed': setNotice(`Session closed: ${String(message.reason).replaceAll('_', ' ')}`); setPhase('closed'); break;
        default: break;
      }
    };
    socket.onerror = () => { setNotice('Connection error.'); setPhase('error'); };
    socket.onclose = () => { socketRef.current = null; setPhase((current) => (current === 'live' || current === 'connecting' ? 'closed' : current)); };
  }, [paint]);

  // --------------------------------------------------------------- start it
  const start = useCallback(async () => {
    setNotice(undefined);
    setPhase('requesting');
    try {
      const created = await apiRequest<CreateResponse>('/v1/remote-desktop/sessions', {
        method: 'POST',
        body: JSON.stringify({ device_id: deviceId, reason: 'Remote support session' }),
      });
      setSession({ id: created.session.id, token: created.viewer_token, expiresAt: created.session.expires_at });
      setPhase('awaiting_approval');
      setNotice(`Awaiting approval · Privileged Action ${created.privileged_action_id}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not request a session.');
      setPhase('error');
    }
  }, [deviceId]);

  // Poll until the approver promotes the session, then connect once.
  useEffect(() => {
    if (phase !== 'awaiting_approval' || !session) return;
    let cancelled = false;
    const poll = window.setInterval(async () => {
      try {
        const { session: current } = await apiRequest<{ session: SessionView }>(`/v1/remote-desktop/sessions/${session.id}`);
        if (cancelled) return;
        if (['AUTHORIZED', 'CONNECTING', 'CONNECTED', 'ACTIVE'].includes(current.status)) {
          window.clearInterval(poll);
          openSocket(session.id, session.token);
        } else if (['CLOSED', 'EXPIRED', 'FAILED'].includes(current.status)) {
          window.clearInterval(poll);
          setPhase('closed');
          setNotice(`Session ${current.status.toLowerCase()}.`);
        }
      } catch { /* transient; the next tick retries */ }
    }, 3000);
    return () => { cancelled = true; window.clearInterval(poll); };
  }, [phase, session, openSocket]);

  const terminate = useCallback(async () => {
    disconnect();
    if (session) { try { await apiRequest(`/v1/remote-desktop/sessions/${session.id}/terminate`, { method: 'POST' }); } catch { /* already closed */ } }
    await remoteQuery.refetch();
  }, [disconnect, session, remoteQuery]);

  // ------------------------------------------------------------------ input
  const sendInput = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify(message)); } catch { /* closing */ }
  }, []);

  /** Canvas pixel position -> normalised 0..1, so scaling never skews the pointer. */
  const position = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  const buttonName = (button: number) => (button === 0 ? 'LEFT' : button === 1 ? 'MIDDLE' : button === 2 ? 'RIGHT' : null);

  const onMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => { if (phase === 'live') sendInput({ type: 'input.mouse.move', ...position(event) }); };
  const onMouseButton = (event: React.MouseEvent<HTMLCanvasElement>, pressed: boolean) => {
    if (phase !== 'live') return;
    const name = buttonName(event.button);
    if (!name) return;
    event.preventDefault();
    sendInput({ type: 'input.mouse.button', ...position(event), button: name, pressed });
  };

  // Keyboard is captured only while the viewport has focus, so the operator's
  // own browser shortcuts keep working everywhere else on the page.
  useEffect(() => {
    if (phase !== 'live') return;
    const modifiers = (event: KeyboardEvent) => ({ ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey });
    const down = (event: KeyboardEvent) => {
      if (document.activeElement !== containerRef.current) return;
      event.preventDefault();
      pressedKeys.current.add(event.code);
      sendInput({ type: 'input.keyboard.keydown', code: event.code, modifiers: modifiers(event) });
    };
    const up = (event: KeyboardEvent) => {
      if (document.activeElement !== containerRef.current) return;
      event.preventDefault();
      pressedKeys.current.delete(event.code);
      sendInput({ type: 'input.keyboard.keyup', code: event.code, modifiers: modifiers(event) });
    };
    // Losing focus mid-chord would otherwise leave a modifier stuck down on
    // the remote machine.
    const release = () => {
      for (const code of pressedKeys.current) sendInput({ type: 'input.keyboard.keyup', code, modifiers: { ctrl: false, alt: false, shift: false, meta: false } });
      pressedKeys.current.clear();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', release);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', release); release(); };
  }, [phase, sendInput]);

  const fullscreen = () => { void containerRef.current?.requestFullscreen?.(); };

  const header = device ? `${device.hostname}` : 'Remote console';
  const live = phase === 'live';

  return (
    <AppShell>
      <div className="mb-4 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Link href="/devices" className="inline-flex items-center gap-1 transition-colors hover:text-primary"><ArrowLeft size={13} /> Devices</Link>
        <ChevronRight size={13} />
        <Link href={`/devices/${deviceId}`} className="transition-colors hover:text-primary">{device?.hostname ?? 'Endpoint'}</Link>
        <ChevronRight size={13} />
        <span className="font-mono-data text-primary">Remote</span>
      </div>

      <PageIntro
        eyebrow="Remote session"
        title={header}
        description="Live desktop control, mediated and audited by Nexora. Nothing is exposed on the endpoint."
        action={
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-border bg-card px-3 py-2 text-[10px] font-semibold text-muted-foreground" data-testid="text-remote-phase">
              {PHASE_LABEL[phase]}{live ? ` · ${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : ''}
            </span>
            {live && <button type="button" onClick={() => setFit((value) => !value)} className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[10px] font-semibold" data-testid="button-remote-scale"><ScanLine size={14} />{fit ? 'Fit' : '1:1'}</button>}
            {live && <button type="button" onClick={fullscreen} className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[10px] font-semibold" data-testid="button-remote-fullscreen"><Maximize2 size={14} />Fullscreen</button>}
            {(live || phase === 'connecting' || phase === 'awaiting_approval') && <button type="button" onClick={() => void terminate()} className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-2 text-[10px] font-semibold text-destructive-foreground" data-testid="button-remote-disconnect"><PowerOff size={14} />Disconnect</button>}
          </div>
        }
      />

      {/* Which machine is being controlled must never be ambiguous. */}
      <Panel className="mb-4">
        <PanelHeading eyebrow="Target" title="Controlled endpoint" />
        <div className="grid gap-px bg-border/60 sm:grid-cols-3 lg:grid-cols-6">
          {([
            ['Device', device?.hostname ?? '—'],
            ['Device ID', deviceId ?? '—'],
            ['Organization', device?.organization_name ?? device?.organization_id ?? '—'],
            ['Site', device?.site_name ?? '—'],
            ['Agent', remote?.agent_version ?? device?.agent_version ?? '—'],
            ['Session', session?.id ?? '—'],
          ] as const).map(([label, value]) => (
            <div key={label} className="bg-card px-4 py-3">
              <p className="text-[10px] text-muted-foreground">{label}</p>
              <p className="truncate text-[11px] font-semibold text-primary" title={String(value)}>{value}</p>
            </div>
          ))}
        </div>
      </Panel>

      {notice && <InlineNotice tone={phase === 'error' ? 'red' : 'amber'}>{notice}</InlineNotice>}

      <Panel className="mt-4">
        <PanelHeading eyebrow="Viewport" title="Live desktop" meta={screen ? `${screen.width} × ${screen.height}` : undefined} />
        <div
          ref={containerRef}
          tabIndex={0}
          className="relative flex min-h-[420px] items-center justify-center overflow-auto bg-black outline-none"
          data-testid="container-remote-viewport"
        >
          {live ? (
            <canvas
              ref={canvasRef}
              onMouseMove={onMouseMove}
              onMouseDown={(event) => onMouseButton(event, true)}
              onMouseUp={(event) => onMouseButton(event, false)}
              onContextMenu={(event) => event.preventDefault()}
              onWheel={(event) => { if (phase === 'live') sendInput({ type: 'input.mouse.wheel', x: 0.5, y: 0.5, deltaY: event.deltaY }); }}
              className={fit ? 'max-h-[70vh] max-w-full object-contain' : ''}
              data-testid="canvas-remote-desktop"
            />
          ) : (
            <div className="px-6 py-16 text-center">
              <Monitor size={28} className="mx-auto text-muted-foreground" />
              <p className="mt-3 text-[12px] font-semibold text-white">{PHASE_LABEL[phase]}</p>
              {blocked
                ? <p className="mt-2 text-[11px] text-muted-foreground" data-testid="text-remote-blocked">{blocked}</p>
                : phase === 'awaiting_approval'
                  ? <p className="mt-2 text-[11px] text-muted-foreground">A different authorized person must approve this session. <Link href="/security/approvals" className="underline">Open approvals</Link></p>
                  : <p className="mt-2 text-[11px] text-muted-foreground">Start a session to control this endpoint.</p>}
              {!blocked && (phase === 'idle' || phase === 'closed' || phase === 'error') && (
                <button type="button" onClick={() => void start()} className="mt-4 rounded-md bg-primary px-4 py-2 text-[11px] font-semibold text-primary-foreground" data-testid="button-remote-start">
                  Start remote session
                </button>
              )}
            </div>
          )}
        </div>
      </Panel>
    </AppShell>
  );
}
