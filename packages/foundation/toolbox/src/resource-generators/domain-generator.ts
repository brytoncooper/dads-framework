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
  plan.create(`${directory}/contract/index.ts`, contractModule(item));
  plan.create(`${directory}/web-client/index.ts`, "export {};\n");
  plan.create(`${directory}/access/index.ts`, accessRegistry(item));
  plan.create(
    `${directory}/server/flags.ts`,
    `import type { FeatureFlagDefinition } from "@dads-framework/feature-flags";\n\n// dad:add imports\n\nexport const featureFlags: FeatureFlagDefinition[] = [\n  // dad:add flags\n];\n`,
  );
  plan.create(`${directory}/server/routes.ts`, routeRegistry());
  plan.create(`${directory}/server/plugin.ts`, domainPlugin(domain));
}

function contractModule(item: string): string {
  const itemCamel = camel(item);
  const typeName = pascal(item);
  const label = title(item);
  return `import { entityIdSchema } from "@dads-framework/core/contract";
import { z } from "zod";

export const ${itemCamel}IdSchema = entityIdSchema("${typeName}Id", "${label} identifier.");
export type ${typeName}Id = z.infer<typeof ${itemCamel}IdSchema>;

export const ${itemCamel}WireSchema = z.strictObject({
  id: ${itemCamel}IdSchema,
  title: z.string().trim().min(1),
});
export type ${typeName}Wire = z.infer<typeof ${itemCamel}WireSchema>;
`;
}

function pureCore(item: string): string {
  const typeName = pascal(item);
  const label = title(item);
  return `import type { ${typeName}Id } from "../contract/index.js";

export type ${typeName}Draft = {
  readonly id: ${typeName}Id;
  readonly title: string;
};

export type Normalized${typeName} = {
  readonly id: ${typeName}Id;
  readonly title: string;
};

export function normalize${typeName}(input: ${typeName}Draft): Normalized${typeName} {
  const normalizedTitle = input.title.trim().replace(/\\s+/g, " ");
  if (normalizedTitle.length === 0) {
    throw new Error("${label} title cannot be empty.");
  }
  return { id: input.id, title: normalizedTitle };
}
`;
}

function pureCoreTest(item: string): string {
  const itemCamel = camel(item);
  const typeName = pascal(item);
  const label = title(item);
  return `import { mintEntityId } from "@dads-framework/core/contract";
import { describe, expect, it } from "vitest";

import { ${itemCamel}IdSchema } from "../contract/index.js";
import { normalize${typeName} } from "./${item}.js";

describe("normalize${typeName}", () => {
  it("trims and collapses whitespace in the title", () => {
    const id = mintEntityId(${itemCamel}IdSchema);
    expect(normalize${typeName}({ id, title: "  Sample   ${label}  " })).toEqual({
      id,
      title: "Sample ${label}",
    });
  });

  it("rejects an empty title", () => {
    const id = mintEntityId(${itemCamel}IdSchema);
    expect(() => normalize${typeName}({ id, title: "   " })).toThrow("${label} title cannot be empty.");
  });
});
`;
}

function accessRegistry(item: string): string {
  const itemCamel = camel(item);
  const wireName = item.replaceAll("-", "_");
  return `import { resource, type DslNode } from "@dads-framework/access";

import { account } from "../../../libraries/app-runtime/index.js";
import { ${itemCamel}IdSchema } from "../contract/index.js";

// dad:add imports

export const ${itemCamel}Resource = resource("${wireName}", {
  id: ${itemCamel}IdSchema,
  roles: { editor: account },
  can: ({ editor }) => ({
    view: editor,
    edit: editor,
  }),
});

export const accessDefinitions: DslNode[] = [
  ${itemCamel}Resource,
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
