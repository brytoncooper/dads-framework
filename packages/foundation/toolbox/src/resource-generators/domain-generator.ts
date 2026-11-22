import type { GenerationPlan } from "./generation-plan.js";
import { camel } from "./names.js";

const IMPORTS = "// dad:add imports";
const DOMAINS = "// dad:add domains";

export function ensureDomain(plan: GenerationPlan, domain: string): void {
  const directory = `domains/${domain}`;
  if (plan.read(`${directory}/index.ts`) !== undefined) {
    requireDomain(plan, domain);
    return;
  }
  plan.create(
    `${directory}/index.ts`,
    `export { ${camel(domain)}Plugin } from "./server/plugin.js";\n// dad:add exports\n`,
  );
  plan.create(
    `${directory}/README.md`,
    `# ${domain}\n\nDomain-owned contracts, access rules, server adapters, and web clients. An API must explicitly select this domain in its app entry point.\n`,
  );
  plan.create(`${directory}/contract/index.ts`, "export {};\n");
  plan.create(`${directory}/web-client/index.ts`, "export {};\n");
  plan.create(`${directory}/access/index.ts`, accessRegistry());
  plan.create(
    `${directory}/server/flags.ts`,
    `import type { FeatureFlagDefinition } from "@dads-framework/feature-flags";\n\n// dad:add imports\n\nexport const featureFlags: FeatureFlagDefinition[] = [\n  // dad:add flags\n];\n`,
  );
  plan.create(`${directory}/server/routes.ts`, routeRegistry());
  plan.create(`${directory}/server/plugin.ts`, domainPlugin(domain));
}

function accessRegistry(): string {
  return `import type { AccessDefinition } from "@dads-framework/access";

// dad:add imports

export const accessDefinitions: Pick<
  AccessDefinition<unknown, unknown>,
  "entity" | "resolve"
>[] = [
  // dad:add access
];
`;
}

function routeRegistry(): string {
  return `import type { HttpRoute } from "@dads-framework/http";
import type { StarterServices } from "../../../libraries/app-runtime/index.js";

// dad:add imports

type RouteFactory = (services: StarterServices) => HttpRoute[];

const factories: RouteFactory[] = [
  // dad:add routes
];

export function domainRoutes(services: StarterServices): HttpRoute[] {
  return factories.flatMap((factory) => factory(services));
}
`;
}

function domainPlugin(domain: string): string {
  return `import { definePlugin } from "@dads-framework/plugin";

import { starterServices } from "../../../libraries/app-runtime/index.js";
import { accessDefinitions } from "../access/index.js";
import { featureFlags } from "./flags.js";
import { domainRoutes } from "./routes.js";

export const ${camel(domain)}Plugin = definePlugin({
  name: "${domain}",
  requires: [starterServices],
  contributes: { access: accessDefinitions, flags: featureFlags },
  setup: ({ use }) => ({
    routes: domainRoutes(use(starterServices)),
  }),
});
`;
}

export function requireDomain(plan: GenerationPlan, domain: string): void {
  if (plan.read(`domains/${domain}/server/plugin.ts`) === undefined) {
    throw new Error(
      `Domain "${domain}" has no server plugin. Run dad add domain ${domain} first.`,
    );
  }
}

export function mountDomain(
  plan: GenerationPlan,
  api: string,
  domain: string,
): void {
  const file = `apps/${api}/app.ts`;
  const plugin = `${camel(domain)}Plugin`;
  plan.appendLine(
    file,
    IMPORTS,
    `import { ${plugin} } from "../../domains/${domain}/index.js";`,
  );
  plan.appendLine(file, DOMAINS, `  ${plugin},`);
}
