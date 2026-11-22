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
    `import { resource } from "@dads-framework/access";

import { account } from "../../../libraries/app-runtime/index.js";

export const ${access} = resource("${wireName}", {
  roles: { editor: account },
  can: ({ editor }) => ({
    view: editor,
    edit: editor,
  }),
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
    `import { fromParam, requires } from "@dads-framework/http";

import { tenantAccess } from "../../../libraries/app-runtime/index.js";

export const ${item}EditPermission = tenantAccess.tenant.permissions.manage_tenant;

export const ${item}View = requires(
  tenantAccess.tenant.permissions.view,
  fromParam("tenantId"),
);

export const ${item}Edit = requires(
  ${item}EditPermission,
  fromParam("tenantId"),
);
`,
  );
}
