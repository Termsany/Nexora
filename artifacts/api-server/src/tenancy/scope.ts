import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, devicesTable, sitesTable } from "@workspace/db";
import { organizationScope, type OrganizationScope, type TenantContext } from "./policy.ts";

export { organizationScope, reachesOrganization, tenantSqlClause } from "./policy.ts";
export type { OrganizationScope, ScopeResult } from "./policy.ts";

/**
 * Drizzle predicate restricting `column` to the scope. Returns undefined when
 * no predicate is needed. An empty scope yields a false predicate so the query
 * returns nothing rather than everything.
 */
export function tenantCondition(column: Parameters<typeof inArray>[0], scope: OrganizationScope): SQL | undefined {
  if (scope === null) return undefined;
  if (scope.length === 0) return sql`false`;
  return inArray(column, scope);
}

/**
 * Loads a device only if the context may reach it.
 *
 * Callers treat a null result as "not found" and return 404 rather than 403, so
 * a caller cannot distinguish another tenant's device from one that does not
 * exist and cannot enumerate device IDs across tenants (§M).
 */
export async function findDeviceInScope(context: TenantContext, deviceId: string) {
  const scope = organizationScope(context);
  if (!scope.ok) return null;
  const condition = tenantCondition(devicesTable.organizationId, scope.organizationIds);
  const [device] = await db.select().from(devicesTable)
    .where(condition ? and(eq(devicesTable.id, deviceId), condition) : eq(devicesTable.id, deviceId));
  return device ?? null;
}

/** Loads a site only if the context may reach its organization. */
export async function findSiteInScope(context: TenantContext, siteId: string) {
  const scope = organizationScope(context);
  if (!scope.ok) return null;
  const condition = tenantCondition(sitesTable.organizationId, scope.organizationIds);
  const [site] = await db.select().from(sitesTable)
    .where(condition ? and(eq(sitesTable.id, siteId), condition) : eq(sitesTable.id, siteId));
  return site ?? null;
}
