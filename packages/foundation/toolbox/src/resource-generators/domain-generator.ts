import type { GenerationPlan } from "./generation-plan.js";
import { camel, pascal, singular, title } from "./names.js";

const IMPORTS = "// dad:add imports";
const DOMAINS = "// dad:add domains";

export function ensureDomain(plan: GenerationPlan, domain: string): void {
  const directory = `domains/${domain}`;
  if (plan.read(`${directory}/index.ts`) !== undefined) {
    requireDomain(plan, domain);
    return;
  }
  const item = singular(domain);
  plan.create(
    `${directory}/index.ts`,
    `export { ${camel(domain)}Plugin } from "./server/plugin.js";\n// dad:add exports\n`,
  );
  plan.create(
    `${directory}/README.md`,
    `# ${domain}\n\nDomain-owned pure logic, contracts, access rules, server adapters, and web clients. An API must explicitly select this domain in its app entry point.\n`,
  );
  plan.create(`${directory}/pure/${item}.ts`, pureCore(item));
  plan.create(`${directory}/pure/${item}.test.ts`, pureCoreTest(item));
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

function pureCore(item: string): string {
  const typeName = pascal(item);
  const label = title(item);
  return `export type ${typeName}Draft = {
  readonly title: string;
};

export type Normalized${typeName} = {
  readonly title: string;
};

export function normalize${typeName}(input: ${typeName}Draft): Normalized${typeName} {
  const normalizedTitle = input.title.trim().replace(/\\s+/g, " ");
  if (normalizedTitle.length === 0) {
    throw new Error("${label} title cannot be empty.");
  }
  return { title: normalizedTitle };
}
`;
}

function pureCoreTest(item: string): string {
  const typeName = pascal(item);
  const label = title(item);
  return `import { describe, expect, it } from "vitest";

import { normalize${typeName} } from "./${item}.js";

describe("normalize${typeName}", () => {
  it("trims and collapses whitespace in the title", () => {
    expect(normalize${typeName}({ title: "  Sample   ${label}  " })).toEqual({
      title: "Sample ${label}",
    });
  });

  it("rejects an empty title", () => {
    expect(() => normalize${typeName}({ title: "   " })).toThrow("${label} title cannot be empty.");
  });
});
`;
}

function accessRegistry(): string {
  return `import type { DslNode } from "@dads-framework/access";

// dad:add imports

export const accessDefinitions: DslNode[] = [
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
  return `import { definePlugin } from "@dads-framework/core/plugin";

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
    throw new Error(`Domain "${domain}" has no server plugin. Run dad add domain ${domain} first.`);
  }
}

export function mountDomain(plan: GenerationPlan, api: string, domain: string): void {
  const file = `apps/${api}/app.ts`;
  const plugin = `${camel(domain)}Plugin`;
  plan.appendLine(file, IMPORTS, `import { ${plugin} } from "../../domains/${domain}/index.js";`);
  plan.appendLine(file, DOMAINS, `  ${plugin},`);
}
