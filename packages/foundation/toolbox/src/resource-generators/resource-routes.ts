import { registerRoutes } from "./endpoint-generator.js";
import type { GenerationPlan } from "./generation-plan.js";
import { camel, pascal, title } from "./names.js";

export function resourceRoutes(
  plan: GenerationPlan,
  domain: string,
  name: string,
): void {
  const id = camel(name);
  const kind = pascal(name);
  const file = `${name}-resource`;
  plan.create(
    `domains/${domain}/server/${file}.ts`,
    `import { notFound, staleSave } from "@dads-framework/errors";
import { getRoute, listRoute, patchRoute, routeGroup } from "@dads-framework/http";

import type { StarterServices } from "../../../libraries/app-runtime/index.js";
import { ${id}Edit, ${id}View } from "../access/${name}-guards.js";
import { ${id}ListRoute, ${id}ReadRoute, ${id}SaveRoute, ${id}Params, ${id}Query, ${id}Record, ${id}Scope, ${id}Update } from "../contract/${file}.js";
import { ${id}Reader } from "./${name}-reader.js";
import type { ${kind}Reader, ${kind}Writer } from "./${name}-store.js";
import { ${id}Writer } from "./${name}-writer.js";

export function ${id}Resource({ db, writeWithPermission }: StarterServices) {
  return create${kind}Routes(${id}Reader(db), ${id}Writer(writeWithPermission));
}

export function create${kind}Routes(reader: ${kind}Reader, writer: ${kind}Writer) {
  return routeGroup("${title(domain)}", [
    listRoute({
      route: ${id}ListRoute,
      summary: "List visible ${title(name)} records",
      access: ${id}View,
      params: ${id}Scope,
      item: ${id}Record,
      query: ${id}Query,
      handler: ({ params, query }) => reader.list({ tenantId: params.tenantId, page: query.page, perPage: query.perPage }),
    }),
    getRoute({
      route: ${id}ReadRoute,
      summary: "Read a ${title(name)} record",
      access: ${id}View,
      params: ${id}Params,
      response: ${id}Record,
      handler: async ({ params }) => {
        const row = await reader.read(params.tenantId, params.id);
        if (row === undefined) throw notFound("RECORD_NOT_FOUND", "The record was not found.");
        return row;
      },
    }),
    patchRoute({
      route: ${id}SaveRoute,
      summary: "Update a ${title(name)} record",
      access: ${id}Edit,
      params: ${id}Params,
      body: ${id}Update,
      response: ${id}Record,
      handler: async ({ params, body, subject }) => {
        const row = await writer.save(subject, params.tenantId, params.id, body);
        if (row === undefined) throw staleSave();
        return row;
      },
    }),
  ]);
}
`,
  );
  registerRoutes(plan, domain, file, `${id}Resource`);
}
