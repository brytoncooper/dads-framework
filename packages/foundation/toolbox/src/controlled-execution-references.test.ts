/** Proves the mechanically validated adapter contract refuses every reference a controlled task cannot back up. */

import { describe, expect, it } from "vitest";
import { assertExecutionReferences } from "./verification-policy-parsing.js";
import type {
  VerificationControlledExecution,
  VerificationControlledInput,
  VerificationPublishedOutput,
  VerificationReusePolicy,
  VerificationTaskDefinition,
} from "./verification/verification-contract.js";

describe("controlled execution references", () => {
  it("accepts a provider and consumer pair that back up every reference", () => {
    const provider = providerTask();
    const consumer = consumerTask();

    expect(() => {
      assertExecutionReferences(consumer, graph(provider, consumer));
    }).not.toThrow();
    expect(() => {
      assertExecutionReferences(provider, graph(provider, consumer));
    }).not.toThrow();
  });

  it("ignores a shell task because it declares no controlled references", () => {
    const shellTask: VerificationTaskDefinition = {
      id: "authorization:live",
      packageName: "boundary",
      command: "node live.mjs",
      dependsOn: [],
      sourceInputs: ["live.mjs"],
      nonSourceInputs: [],
      reusePolicy: "never",
      execution: { kind: "shell" },
    };

    expect(() => {
      assertExecutionReferences(shellTask, graph(shellTask));
    }).not.toThrow();
  });

  it("refuses a controlled runner that does not run from the snapshot root", () => {
    const consumer = consumerTask({
      execution: consumerExecution({ workingDirectory: "packages/consumer" }),
    });

    expect(() => {
      assertExecutionReferences(consumer, graph(providerTask(), consumer));
    }).toThrow("Controlled verification must run from the snapshot root.");
  });

  it("refuses a controlled runner that takes arguments", () => {
    const consumer = consumerTask({
      execution: consumerExecution({
        runnerArguments: ["--reporter", "json"],
      }),
    });

    expect(() => {
      assertExecutionReferences(consumer, graph(providerTask(), consumer));
    }).toThrow("Controlled verification runner arguments are not allowed.");
  });

  it("refuses a command that does not exactly name its runner entrypoint", () => {
    const consumer = consumerTask({ command: "node consumer.mjs --watch" });

    expect(() => {
      assertExecutionReferences(consumer, graph(providerTask(), consumer));
    }).toThrow(
      "Controlled verification command for consumer:test must exactly name its runner entrypoint.",
    );
  });

  it("refuses an output prerequisite no task in the graph declares", () => {
    const consumer = consumerTask({
      dependsOn: ["policy:absent"],
      execution: consumerExecution({
        prerequisiteOutputTaskIds: ["policy:absent"],
      }),
    });

    expect(() => {
      assertExecutionReferences(consumer, graph(providerTask(), consumer));
    }).toThrow(
      "output prerequisites for consumer:test references unknown task policy:absent.",
    );
  });

  it("refuses an output prerequisite that is not an execution dependency", () => {
    const consumer = consumerTask({ dependsOn: [] });

    expect(() => {
      assertExecutionReferences(consumer, graph(providerTask(), consumer));
    }).toThrow(
      "Output prerequisite policy:build must be an execution dependency of consumer:test.",
    );
  });

  it("refuses an output prerequisite that is not a controlled task", () => {
    const shellProvider: VerificationTaskDefinition = {
      ...providerTask(),
      execution: { kind: "shell" },
    };
    const consumer = consumerTask();

    expect(() => {
      assertExecutionReferences(consumer, graph(shellProvider, consumer));
    }).toThrow("Output prerequisite policy:build must be a controlled task.");
  });

  it("refuses a consumer that does not consume a published output as an artifact", () => {
    const consumer = consumerTask({
      execution: consumerExecution({
        inputFiles: [
          { path: "consumer.mjs", role: "test" },
          { path: "generated/policy.json", role: "source" },
        ],
      }),
    });

    expect(() => {
      assertExecutionReferences(consumer, graph(providerTask(), consumer));
    }).toThrow(
      "consumer:test must consume published output generated/policy.json as an artifact.",
    );
  });

  it("refuses an output prerequisite that publishes no generated artifact", () => {
    const emptyProvider: VerificationTaskDefinition = {
      ...providerTask(),
      reusePolicy: "never",
      execution: providerExecution({ publishOutputs: [] }),
    };
    const consumer = consumerTask({
      execution: consumerExecution({
        inputFiles: [{ path: "consumer.mjs", role: "test" }],
      }),
    });

    expect(() => {
      assertExecutionReferences(consumer, graph(emptyProvider, consumer));
    }).toThrow(
      "Output prerequisite policy:build must publish a generated artifact.",
    );
  });

  it("refuses a published output the task does not require back", () => {
    const provider: VerificationTaskDefinition = {
      ...providerTask(),
      execution: providerExecution({ outputFiles: ["other.json"] }),
    };

    expect(() => {
      assertExecutionReferences(provider, graph(provider));
    }).toThrow(
      "Published output policy.json is not required from policy:build.",
    );
  });

  it("refuses an artifact provider that is reusable, publishes nothing, or consumes a prerequisite", () => {
    const reusableProvider: VerificationTaskDefinition = {
      ...providerTask(),
      reusePolicy: "candidate",
    };
    const silentProvider: VerificationTaskDefinition = {
      ...providerTask(),
      execution: providerExecution({
        outputFiles: ["policy.json"],
        publishOutputs: [],
      }),
    };
    const providerMessage =
      "Artifact provider policy:build must be non-reusable, publish output, and have no artifact prerequisite.";

    expect(() => {
      assertExecutionReferences(reusableProvider, graph(reusableProvider));
    }).toThrow(providerMessage);
    expect(() => {
      assertExecutionReferences(silentProvider, graph(silentProvider));
    }).toThrow(providerMessage);
  });

  it("refuses an artifact consumer that is not reusable, publishes output, or consumes nothing", () => {
    const provider = providerTask();
    const neverReusedConsumer = consumerTask({ reusePolicy: "never" });
    const publishingConsumer = consumerTask({
      execution: consumerExecution({
        outputFiles: ["result.json", "policy.json"],
        publishOutputs: [
          { outputPath: "policy.json", projectPath: "generated/copy.json" },
        ],
      }),
    });
    const rootlessConsumer = consumerTask({
      dependsOn: [],
      execution: consumerExecution({
        prerequisiteOutputTaskIds: [],
        inputFiles: [{ path: "consumer.mjs", role: "test" }],
      }),
    });
    const consumerMessage =
      "Artifact consumer consumer:test must be reusable, consume a prerequisite, and publish no project output.";

    expect(() => {
      assertExecutionReferences(
        neverReusedConsumer,
        graph(provider, neverReusedConsumer),
      );
    }).toThrow(consumerMessage);
    expect(() => {
      assertExecutionReferences(
        publishingConsumer,
        graph(provider, publishingConsumer),
      );
    }).toThrow(consumerMessage);
    expect(() => {
      assertExecutionReferences(
        rootlessConsumer,
        graph(provider, rootlessConsumer),
      );
    }).toThrow(consumerMessage);
  });
});

type ControlledExecutionOverrides = {
  readonly workingDirectory?: string;
  readonly runnerArguments?: readonly string[];
  readonly inputFiles?: readonly VerificationControlledInput[];
  readonly outputFiles?: readonly string[];
  readonly publishOutputs?: readonly VerificationPublishedOutput[];
  readonly prerequisiteOutputTaskIds?: readonly string[];
};

type ControlledTaskOverrides = {
  readonly command?: string;
  readonly dependsOn?: readonly string[];
  readonly reusePolicy?: VerificationReusePolicy;
  readonly execution?: VerificationControlledExecution;
};

function providerExecution(
  overrides: ControlledExecutionOverrides = {},
): VerificationControlledExecution {
  return {
    kind: "controlled-node",
    adapter: "artifact-provider-v1",
    workingDirectory: overrides.workingDirectory ?? ".",
    runnerEntrypoint: "provider.mjs",
    runnerArguments: overrides.runnerArguments ?? [],
    runnerVersion: "boundary-runner-v1",
    inputFiles: overrides.inputFiles ?? [
      { path: "provider.mjs", role: "test" },
    ],
    outputFiles: overrides.outputFiles ?? ["policy.json"],
    publishOutputs: overrides.publishOutputs ?? [
      { outputPath: "policy.json", projectPath: "generated/policy.json" },
    ],
    environment: [],
    prerequisiteOutputTaskIds: overrides.prerequisiteOutputTaskIds ?? [],
    timeoutMilliseconds: 5_000,
  };
}

function consumerExecution(
  overrides: ControlledExecutionOverrides = {},
): VerificationControlledExecution {
  return {
    kind: "controlled-node",
    adapter: "artifact-consumer-v1",
    workingDirectory: overrides.workingDirectory ?? ".",
    runnerEntrypoint: "consumer.mjs",
    runnerArguments: overrides.runnerArguments ?? [],
    runnerVersion: "boundary-runner-v1",
    inputFiles: overrides.inputFiles ?? [
      { path: "consumer.mjs", role: "test" },
      { path: "generated/policy.json", role: "artifact" },
    ],
    outputFiles: overrides.outputFiles ?? ["result.json"],
    publishOutputs: overrides.publishOutputs ?? [],
    environment: [],
    prerequisiteOutputTaskIds: overrides.prerequisiteOutputTaskIds ?? [
      "policy:build",
    ],
    timeoutMilliseconds: 5_000,
  };
}

function providerTask(
  overrides: ControlledTaskOverrides = {},
): VerificationTaskDefinition {
  return {
    id: "policy:build",
    packageName: "boundary",
    command: overrides.command ?? "node provider.mjs",
    dependsOn: overrides.dependsOn ?? [],
    sourceInputs: ["provider.mjs"],
    nonSourceInputs: [],
    reusePolicy: overrides.reusePolicy ?? "never",
    execution: overrides.execution ?? providerExecution(),
  };
}

function consumerTask(
  overrides: ControlledTaskOverrides = {},
): VerificationTaskDefinition {
  return {
    id: "consumer:test",
    packageName: "boundary",
    command: overrides.command ?? "node consumer.mjs",
    dependsOn: overrides.dependsOn ?? ["policy:build"],
    sourceInputs: ["consumer.mjs"],
    nonSourceInputs: [],
    reusePolicy: overrides.reusePolicy ?? "candidate",
    execution: overrides.execution ?? consumerExecution(),
  };
}

function graph(
  ...tasks: readonly VerificationTaskDefinition[]
): ReadonlyMap<string, VerificationTaskDefinition> {
  return new Map(tasks.map((task) => [task.id, task]));
}
