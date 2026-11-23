import type { GenerationPlan } from "./generation-plan.js";
import { pascal } from "./names.js";

export function addIntegration(plan: GenerationPlan, name: string): void {
  plan.create(`integrations/${name}/index.ts`, integrationSource(name));
  plan.create(`integrations/${name}/${name}.test.ts`, integrationTest(name));
}

function integrationSource(name: string): string {
  const typeName = pascal(name);
  return `export type ${typeName}Request = {
  readonly id: string;
};

export type ${typeName}Response = {
  readonly externalId: string;
};

export type ${typeName}Port = {
  readonly send: (request: ${typeName}Request) => Promise<${typeName}Response>;
};

export type ${typeName}AdapterOptions = {
  readonly transport: (request: ${typeName}Request) => Promise<${typeName}Response>;
};

export function create${typeName}Adapter(options: ${typeName}AdapterOptions): ${typeName}Port {
  return {
    send: (request) => options.transport(request),
  };
}
`;
}

function integrationTest(name: string): string {
  const typeName = pascal(name);
  return `import { describe, expect, it } from "vitest";

import { create${typeName}Adapter } from "./index.js";

describe("create${typeName}Adapter", () => {
  it("delegates requests through the injected transport seam", async () => {
    const seen: string[] = [];
    const adapter = create${typeName}Adapter({
      transport: (request) => {
        seen.push(request.id);
        return Promise.resolve({ externalId: \`${name}:\${request.id}\` });
      },
    });

    const response = await adapter.send({ id: "item-1" });
    expect(response).toEqual({ externalId: "${name}:item-1" });
    expect(seen).toEqual(["item-1"]);
  });
});
`;
}
