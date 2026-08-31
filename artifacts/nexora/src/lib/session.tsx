import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from './api';

export type PlatformRole = 'PLATFORM_SUPER_ADMIN' | 'PLATFORM_ADMIN' | 'PLATFORM_TECHNICIAN';
export type OrganizationRole = 'ORGANIZATION_ADMIN' | 'ORGANIZATION_TECHNICIAN' | 'ORGANIZATION_VIEWER';

export type SessionOrganization = {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  role: OrganizationRole | null;
};

export type SessionIdentity = {
  authenticated: boolean;
  principal_kind: 'user' | 'platform-api';
  platform_access: boolean;
  user: { id: string; email: string; name: string; scope: 'PLATFORM' | 'ORGANIZATION'; platform_role: PlatformRole | null } | null;
  organizations: SessionOrganization[];
};

export const SESSION_QUERY_KEY = ['session'] as const;

/**
 * Fetches the current identity. A 401 is a normal, expected answer for a signed
 * out visitor, so it resolves to null rather than throwing into an error state.
 */
async function fetchSession(): Promise<SessionIdentity | null> {
  const response = await fetch('/api/v1/auth/me', { credentials: 'same-origin' });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Session lookup failed (${response.status}).`);
  return response.json() as Promise<SessionIdentity>;
}

type SessionContextValue = {
  session: SessionIdentity | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSession,
    retry: false,
    staleTime: 60_000,
  });

  const logout = useCallback(async () => {
    await apiRequest('/v1/auth/logout', { method: 'POST' });
    // Every cached response was fetched under the previous identity, so the
    // whole cache is discarded rather than just the session entry.
    queryClient.clear();
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  }, [queryClient]);

  const value = useMemo<SessionContextValue>(() => ({
    session: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
    logout,
  }), [query.data, query.isLoading, query.isError, query.refetch, logout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider');
  return context;
}

const SCOPE_STORAGE_KEY = 'nexora-organization-scope';

type OrganizationScopeValue = {
  /** null means "every organization the account can reach". */
  organizationId: string | null;
  setOrganizationId: (organizationId: string | null) => void;
  organizations: SessionOrganization[];
};

const OrganizationScopeContext = createContext<OrganizationScopeValue | null>(null);

/**
 * The organization selector in the shell.
 *
 * This is a query-scope convenience only. It is never the security boundary:
 * the value is sent as `organization_id` and the server rejects any
 * organization the caller has no access to, rather than trusting the selection.
 */
export function OrganizationScopeProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [organizationId, setStored] = useState<string | null>(() => {
    try { return window.sessionStorage.getItem(SCOPE_STORAGE_KEY); } catch { return null; }
  });

  const organizations = session?.organizations ?? [];
  // A remembered selection is dropped once it is no longer reachable, so a
  // stale value cannot linger after a membership is removed.
  const effective = organizationId && organizations.some((organization) => organization.id === organizationId)
    ? organizationId
    : null;

  const setOrganizationId = useCallback((next: string | null) => {
    setStored(next);
    try {
      if (next) window.sessionStorage.setItem(SCOPE_STORAGE_KEY, next);
      else window.sessionStorage.removeItem(SCOPE_STORAGE_KEY);
    } catch { /* private browsing; the selection simply is not remembered */ }
  }, []);

  const value = useMemo<OrganizationScopeValue>(
    () => ({ organizationId: effective, setOrganizationId, organizations }),
    [effective, setOrganizationId, organizations],
  );
  return <OrganizationScopeContext.Provider value={value}>{children}</OrganizationScopeContext.Provider>;
}

export function useOrganizationScope(): OrganizationScopeValue {
  const context = useContext(OrganizationScopeContext);
  if (!context) return { organizationId: null, setOrganizationId: () => undefined, organizations: [] };
  return context;
}

const ORGANIZATION_CAPABILITIES: Record<OrganizationRole, string[]> = {
  ORGANIZATION_VIEWER: ['organization:read', 'site:read', 'device:read', 'alert:read', 'software:read', 'inventory:read'],
  ORGANIZATION_TECHNICIAN: ['organization:read', 'site:read', 'device:read', 'alert:read', 'software:read', 'inventory:read', 'alert:acknowledge', 'device:assign-site', 'enrollment-token:read'],
  ORGANIZATION_ADMIN: ['organization:read', 'site:read', 'device:read', 'alert:read', 'software:read', 'inventory:read', 'alert:acknowledge', 'device:assign-site', 'site:manage', 'organization:update', 'enrollment-token:read', 'enrollment-token:manage', 'membership:read', 'membership:manage', 'notification:read'],
};

const PLATFORM_CAPABILITIES: Record<PlatformRole, string[]> = {
  PLATFORM_TECHNICIAN: ['organization:read', 'site:read', 'device:read', 'alert:read', 'software:read', 'inventory:read', 'alert:acknowledge', 'device:assign-site', 'notification:read'],
  PLATFORM_ADMIN: ['organization:read', 'site:read', 'device:read', 'alert:read', 'software:read', 'inventory:read', 'alert:acknowledge', 'device:assign-site', 'organization:create', 'organization:update', 'site:manage', 'enrollment-token:read', 'enrollment-token:manage', 'membership:read', 'membership:manage', 'notification:read', 'notification:manage'],
  PLATFORM_SUPER_ADMIN: ['organization:read', 'site:read', 'device:read', 'alert:read', 'software:read', 'inventory:read', 'alert:acknowledge', 'device:assign-site', 'organization:create', 'organization:update', 'site:manage', 'enrollment-token:read', 'enrollment-token:manage', 'membership:read', 'membership:manage', 'notification:read', 'notification:manage', 'user:manage'],
};

/**
 * Mirrors the server's capability table so navigation and controls can be
 * shaped to the signed-in role.
 *
 * This is presentation only. It is not a security boundary: the API enforces
 * the same rules independently, and hiding a button here never grants or
 * withholds access on its own.
 */
export function useCapability(capability: string, organizationId?: string): boolean {
  const { session } = useSession();
  if (!session) return false;
  if (session.platform_access) {
    const role = session.user?.platform_role;
    // The administrative API token has platform access with no user record and
    // is treated as the highest platform role.
    if (session.principal_kind === 'platform-api') return PLATFORM_CAPABILITIES.PLATFORM_SUPER_ADMIN.includes(capability);
    return role ? PLATFORM_CAPABILITIES[role].includes(capability) : false;
  }
  const organizations = organizationId
    ? session.organizations.filter((organization) => organization.id === organizationId)
    : session.organizations;
  return organizations.some((organization) => organization.role && ORGANIZATION_CAPABILITIES[organization.role].includes(capability));
}
