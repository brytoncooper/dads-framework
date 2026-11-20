import type { GenerationPlan } from "./generation-plan.js";
import { camel } from "./names.js";

export function addAccess(
  plan: GenerationPlan,
  domain: string,
  name: string,
): void {
  const access = `${camel(name)}Access`;
  const directory = `domains/${domain}/access`;
  const wireName = `${domain}/${name}`.replaceAll("-", "_");
  plan.create(
    `${directory}/${name}.ts`,
    `import { access, entityHandle } from "@dads-framework/access";
import { z } from "zod";

import { accountEntity } from "../../../libraries/app-runtime/index.js";

const resource = entityHandle({
  wireName: "${wireName}",
  kind: "record",
  idSchema: z.string().min(1),
});

export const ${access} = access(resource, {
  roles: { editor: accountEntity },
  permissions: (roles) => ({ view: [roles.editor], edit: [roles.editor] }),
});
`,
  );
  plan.appendLine(
    `${directory}/index.ts`,
    "// dad:add imports",
    `import { ${access} } from "./${name}.js";`,
  );
  plan.appendLine(`${directory}/index.ts`, "// dad:add access", `  ${access},`);
}

/** Record collection routes are bounded by one authorized tenant. */
export function addResourceGuards(
  plan: GenerationPlan,
  domain: string,
  name: string,
): void {
  const item = camel(name);
  plan.create(
    `domains/${domain}/access/${name}-guards.ts`,
    `import { fromParam, type PermissionAccess } from "@dads-framework/http";

import { tenantAccess } from "../../../libraries/app-runtime/index.js";

const view = tenantAccess.tenant.permissions.view;
export const ${item}EditPermission = tenantAccess.tenant.permissions.manage_tenant;

export const ${item}View: PermissionAccess = {
  kind: "permission",
  resourceType: view.entityWireName,
  permission: view.permissionName,
  resourceId: fromParam("tenantId"),
};

export const ${item}Edit: PermissionAccess = {
  kind: "permission",
  resourceType: ${item}EditPermission.entityWireName,
  permission: ${item}EditPermission.permissionName,
  resourceId: fromParam("tenantId"),
};
`,
  );
}
