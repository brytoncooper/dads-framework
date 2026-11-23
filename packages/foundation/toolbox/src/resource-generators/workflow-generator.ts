import type { GenerationPlan } from "./generation-plan.js";
import { pascal, title } from "./names.js";

export function addWorkflow(plan: GenerationPlan, name: string): void {
  plan.create(`workflows/${name}.ts`, workflowSource(name));
  plan.create(`workflows/${name}.test.ts`, workflowTest(name));
}

function workflowSource(name: string): string {
  const typeName = pascal(name);
  const label = title(name);
  return `export type ${typeName}Input = {
  readonly id: string;
};

export type ${typeName}Result = {
  readonly id: string;
  readonly status: "completed";
};

export type ${typeName}Ports = {
  readonly verify: (id: string) => Promise<boolean>;
  readonly record: (id: string) => Promise<void>;
};

export async function run${typeName}(
  input: ${typeName}Input,
  ports: ${typeName}Ports,
): Promise<${typeName}Result> {
  const allowed = await ports.verify(input.id);
  if (!allowed) {
    throw new Error("${label} precondition failed.");
  }
  await ports.record(input.id);
  return { id: input.id, status: "completed" };
}
`;
}

function workflowTest(name: string): string {
  const typeName = pascal(name);
  const label = title(name);
  return `import { describe, expect, it } from "vitest";

import { run${typeName} } from "./${name}.js";

describe("run${typeName}", () => {
  it("coordinates ports in order when preconditions hold", async () => {
    const recorded: string[] = [];
    const result = await run${typeName}(
      { id: "example-1" },
      {
        verify: () => Promise.resolve(true),
        record: (id) => {
          recorded.push(id);
          return Promise.resolve();
        },
      },
    );
    expect(result).toEqual({ id: "example-1", status: "completed" });
    expect(recorded).toEqual(["example-1"]);
  });

  it("refuses to record when preconditions fail", async () => {
    const recorded: string[] = [];
    await expect(
      run${typeName}(
        { id: "example-1" },
        {
          verify: () => Promise.resolve(false),
          record: (id) => {
            recorded.push(id);
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow("${label} precondition failed.");
    expect(recorded).toEqual([]);
  });
});
`;
}
