import { apiRequest } from '@/lib/api';

/**
 * Authenticated read helper for the console.
 *
 * Before Task #008 this attached a shared administrative bearer token kept in
 * `sessionStorage`. The console no longer holds any credential: requests carry
 * the httpOnly session cookie, and the server derives the caller's tenant scope
 * from it. The administrative API token remains a platform-level machine
 * credential and is never exposed to the browser.
 */
export function adminFetch<T>(path: string): Promise<T> {
  return apiRequest<T>(`/v1${path}`);
}
