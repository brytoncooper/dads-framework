import type { GenerationPlan } from "./generation-plan.js";
import { camel, title } from "./names.js";

export function addEndpoint(plan: GenerationPlan, domain: string, name: string): void {
  const item = camel(name);
  const base = `domains/${domain}`;
  const path = `/${domain}/${name}`;
  plan.create(
    `${base}/contract/${name}-endpoint.ts`,
    `import { z } from "zod";

export const ${item}Path = "${path}";
export const ${item}Response = z.strictObject({ status: z.literal("ok") });
`,
  );
  plan.create(
    `${base}/server/${name}-endpoint.ts`,
    `import { getRoute, requireSession, routeGroup } from "@dads-framework/http";

import { ${item}Path, ${item}Response } from "../contract/${name}-endpoint.js";

export function ${item}Endpoint() {
  return routeGroup("${title(domain)}", [
    getRoute({
      route: { method: "GET", template: ${item}Path },
      summary: "${title(name)}",
      access: requireSession(),
      response: ${item}Response,
      handler: () => ${item}Response.parse({ status: "ok" }),
    }),
  ]);
}
`,
  );
  plan.create(`${base}/server/${name}-endpoint.test.ts`, endpointTest(domain, name));
  registerRoutes(plan, domain, `${name}-endpoint`, `${item}Endpoint`);
}

export function registerRoutes(plan: GenerationPlan, domain: string, file: string, factory: string): void {
  const registry = `domains/${domain}/server/routes.ts`;
  plan.appendLine(registry, "// dad:add imports", `import { ${factory} } from "./${file}.js";`);
  plan.appendLine(registry, "// dad:add routes", `  ${factory},`);
}

function endpointTest(domain: string, name: string): string {
  const item = camel(name);
  return `import { createHttpApp, registerRoutes } from "@dads-framework/http";
import { expect, it } from "vitest";

import { account } from "../../../libraries/app-runtime/index.js";
import { ${item}Path } from "../contract/${name}-endpoint.js";
import { ${item}Endpoint } from "./${name}-endpoint.js";

it("serves a signed-in caller and denies an anonymous caller", async () => {
  const app = await createHttpApp({ nodeEnv: "test", trustedOrigins: [], logger: false });
  try {
    registerRoutes(app, {
      routes: ${item}Endpoint(),
      authorization: { check: () => Promise.resolve(false) },
      subjects: {
        resolve: (request) => Promise.resolve(request.headers["x-example-session"] === "yes" ? { type: account.wireName, id: "example" } : null),
      },
    });
    const allowed = await app.inject({ method: "GET", url: ${item}Path, headers: { "x-example-session": "yes" } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ data: { status: "ok" } });
    const denied = await app.inject({ method: "GET", url: ${item}Path });
    expect(denied.statusCode).toBe(401);
  } finally {
    await app.close();
  }
});
`;
}
