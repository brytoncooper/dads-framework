import type { GenerationPlan } from "./generation-plan.js";
import { camel, pascal } from "./names.js";

export function resourceContract(plan: GenerationPlan, domain: string, name: string): void {
  const id = camel(name);
  const kind = pascal(name);
  const file = `domains/${domain}/contract/${name}-resource.ts`;
  plan.create(
    file,
    `import {
  defineRoute,
  expectedRowVersionFields,
  paginationQuerySchema,
  rowVersionSchema,
} from "@dads-framework/core/contract";
import { tenantIdSchema } from "@dads-framework/identity/tenants";
import { z } from "zod";

const collectionPath = "/tenants/:tenantId/${domain}/${name}";
const detailPath = "/tenants/:tenantId/${domain}/${name}/:id";
const bindCollection = (tenantId: string) => collectionPath.replace(":tenantId", encodeURIComponent(tenantId));
const bindDetail = (tenantId: string, id: string) => detailPath.replace(":tenantId", encodeURIComponent(tenantId)).replace(":id", encodeURIComponent(id));
export const ${id}ListRoute = defineRoute("GET", collectionPath, bindCollection);
export const ${id}ReadRoute = defineRoute("GET", detailPath, bindDetail);
export const ${id}SaveRoute = defineRoute("PATCH", detailPath, bindDetail);

export const ${id}Scope = z.strictObject({ tenantId: tenantIdSchema });
export const ${id}Params = ${id}Scope.extend({ id: z.string().min(1) });
export const ${id}Query = paginationQuerySchema;
export const ${id}Update = z.strictObject({
  title: z.string().trim().min(1).max(200),
  ...expectedRowVersionFields,
});
export const ${id}Record = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  rowVersion: rowVersionSchema,
});

export type ${kind} = z.infer<typeof ${id}Record>;
export type ${kind}Update = z.infer<typeof ${id}Update>;
`,
  );
}
