import { paginationQuerySchema } from "@dads-framework/contract";
import { listRoute, postRoute, routeGroup } from "@dads-framework/http";
import type { Tenants } from "@dads-framework/tenants";
import { tenantInput, tenantRecord } from "../contract/index.js";

export function tenantRoutes(tenants: Tenants) {
  return routeGroup("Tenants", [
    listRoute({
      route: { method: "GET", template: "/tenants" },
      summary: "List the signed-in account's tenants",
      access: { kind: "session" },
      item: tenantRecord,
      query: paginationQuerySchema,
      handler: async ({ query, subject }) => {
        const visible = await tenants.list(subject.id);
        const first = (query.page - 1) * query.perPage;
        return {
          items: visible.slice(first, first + query.perPage),
          total: visible.length,
        };
      },
    }),
    postRoute({
      route: { method: "POST", template: "/tenants" },
      summary: "Create a tenant owned by this account",
      access: { kind: "session" },
      body: tenantInput,
      response: tenantRecord,
      handler: ({ body, subject }) => tenants.create(subject.id, body.name),
    }),
  ]);
}
