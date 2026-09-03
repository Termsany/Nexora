// The zod request/response schemas are the values consumers use, so they are
// re-exported directly. Orval also emits TypeScript types under ./generated/types,
// and for query-parameter shapes (GetDeviceMetricsParams, ListOrganizationSitesParams,
// …) a type and a schema share a name — `export *` from both would be ambiguous.
// The types are therefore namespaced rather than dropped; the same types are also
// published by @workspace/api-client-react.
export * from "./generated/api";
export * as types from "./generated/types";
