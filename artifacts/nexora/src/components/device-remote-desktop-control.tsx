import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, MonitorPlay, Power, RefreshCw } from 'lucide-react';
import { apiRequest } from '@/lib/api';
import { useCapability } from '@/lib/session';

type DesktopState = {
  device_id: string;
  remote_desktop_enabled: boolean;
  agent_supports_remote_desktop: boolean;
};

export function DeviceRemoteDesktopControl({ deviceId, organizationId }: {
  deviceId: string;
  organizationId: string;
}) {
  const canRead = useCapability('device:read', organizationId);
  // Existing UI alias for the endpoint's devices.manage permission.
  const canManage = useCapability('device:assign-site', organizationId);
  const [notice, setNotice] = useState('');
  const path = `/v1/devices/${encodeURIComponent(deviceId)}/remote-desktop`;
  const state = useQuery({
    queryKey: ['device-remote-desktop', organizationId, deviceId],
    queryFn: () => apiRequest<DesktopState>(path),
    enabled: canRead,
    retry: false,
    refetchInterval: 30000,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => apiRequest<{ remote_desktop_enabled: boolean }>(path, {
      method: 'PATCH', body: JSON.stringify({ enabled }),
    }),
    onMutate: () => setNotice(''),
    onSuccess: async () => { await state.refetch(); },
    onError: () => setNotice('Could not update Remote Desktop. Check your permissions and try again.'),
  });
  if (!canRead) return null;
  const known = !state.isError && state.data?.device_id === deviceId;
  const enabled = known && state.data?.remote_desktop_enabled === true;
  return <section aria-label="Remote Desktop" className="mb-5 border-y border-border py-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <MonitorPlay size={18} className="shrink-0 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-semibold text-primary">Remote Desktop</h2>
          <p aria-live="polite" className="mt-1 text-xs text-muted-foreground">
            Status: {state.isLoading ? 'Loading...' : known ? enabled ? 'ON' : 'OFF' : 'Unavailable'}
          </p>
        </div>
      </div>
      {canManage && <button type="button"
        disabled={!known || state.isFetching || toggle.isPending}
        onClick={() => toggle.mutate(!enabled)}
        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-semibold text-primary disabled:cursor-not-allowed disabled:opacity-50">
        {toggle.isPending ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
        {toggle.isPending ? 'Saving...' : enabled ? 'Disable Remote Desktop' : 'Enable Remote Desktop'}
      </button>}
    </div>
    {state.isError && <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-xs text-destructive">
      Remote Desktop status could not be loaded.
      <button type="button" onClick={() => void state.refetch()} disabled={state.isFetching}
        className="inline-flex items-center gap-1 underline"><RefreshCw size={12} />Retry</button>
    </div>}
    {notice && <p role="alert" className="mt-3 text-xs text-destructive">{notice}</p>}
    {known && !state.data?.agent_supports_remote_desktop &&
      <p className="mt-3 text-xs text-muted-foreground">Agent support: not reported</p>}
  </section>;
}
