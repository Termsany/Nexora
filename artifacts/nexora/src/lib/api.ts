import { useQuery } from '@tanstack/react-query';

/**
 * Minimal fetch helper for the tenancy endpoints that are read through plain
 * queries rather than the generated react-query client.
 *
 * `credentials: 'same-origin'` carries the httpOnly session cookie. No token is
 * read from or written to browser storage — the console holds no credential of
 * its own.
 */
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init?.headers as Record<string, string> };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('nexora_csrf='))?.slice('nexora_csrf='.length);
    if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf);
  }
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers,
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    if (response.status === 401) message = 'Your session has expired. Sign in again.';
    else if (response.status === 403) message = 'You do not have permission to perform this action.';
    else {
      try {
        const body = await response.json() as { error?: string };
        if (body?.error) message = body.error;
      } catch { /* keep the status-based message */ }
    }
    throw new Error(message);
  }
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
}

export function useApiQuery<T>(key: readonly unknown[], path: string, enabled = true) {
  return useQuery<T>({ queryKey: key, queryFn: () => apiRequest<T>(path), enabled, retry: false });
}
