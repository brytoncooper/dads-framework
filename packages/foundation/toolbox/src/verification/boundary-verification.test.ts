/** Proves graph execution only reuses a controlled consumer after current providers prove its exact inputs. */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDadsProject } from "../project-orientation.js";
import { recommendChangedVerification } from "../recommend-changed-verification.js";
import type {
  VerificationControlledExecution,
  VerificationControlledInput,
  VerificationTaskResult,
} from "./verification-contract.js";
import { formatVerificationReport } from "./format-verification-report.js";
import { environmentWithoutGitVariables } from "./git-environment.js";
import { verifyTaskGraph } from "./verify-task-graph.js";
import {
  captureWorkspaceSnapshot,
  discardWorkspaceSnapshot,
  readWorkspaceIdentity,
} from "./workspace-snapshot.js";

const temporaryProjects: string[] = [];

afterEach(() => {
  for (const projectRoot of temporaryProjects.splice(0)) {
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

describe("boundary verification graph", () => {
  it("executes providers bottom-up and reuses an exact controlled consumer", () => {
    const projectRoot = createBoundaryProject();
    const project = boundaryProject();

    const baseline = verifyAuthoringChange(projectRoot, project);
    expect(baseline.issues).toEqual([]);
    expect(resultStates(baseline.results)).toEqual({
      "policy:check": "executed",
      "policy:build": "executed",
      "consumer:test": "executed",
      "authorization:live": "executed",
    });
    expect(baseline.ok).toBe(true);

    writeFileSync(
      join(projectRoot, "authoring.txt"),
      "# source-only extraction\nreader\n",
    );
    const unchangedArtifact = verifyAuthoringChange(projectRoot, project);
    expect(resultStates(unchangedArtifact.results)).toEqual({
      "policy:check": "executed",
      "policy:build": "executed",
      "consumer:test": "reused",
      "authorization:live": "executed",
    });

    writeFileSync(join(projectRoot, "authoring.txt"), "writer\n");
    const changedArtifact = verifyAuthoringChange(projectRoot, project);
    expect(resultStates(changedArtifact.results)["consumer:test"]).toBe(
      "executed",
    );
  });

  it.each([
    "consumer-source.txt",
    "consumer.test.txt",
    "consumer.config.json",
    "engine.mjs",
    "binding.mjs",
    "toolchain.lock",
  ])("invalidates controlled evidence when %s changes", (input) => {
    const projectRoot = createBoundaryProject();
    const project = boundaryProject();
    verifyAuthoringChange(projectRoot, project);

    writeFileSync(join(projectRoot, input), `${input}:changed\n`);
    const report = verifyConsumerChange(projectRoot, project, input);
    expect(resultStates(report.results)["consumer:test"]).toBe("executed");
  });

  it("invalidates controlled evidence when its environment or runner changes", () => {
    const projectRoot = createBoundaryProject();
    const project = boundaryProject();
    verifyAuthoringChange(projectRoot, project);

    const invalidatingProjects = [
      boundaryProject({ consumerEnvironment: "changed" }),
      boundaryProject({ consumerRunnerVersion: "boundary-runner-v2" }),
    ];
    for (const changedProject of invalidatingProjects) {
      const report = verifyAuthoringChange(projectRoot, changedProject);
      expect(resultStates(report.results)["consumer:test"]).toBe("executed");
    }
  });

  it("blocks dependents after provider failure and never reuses live or full tasks", () => {
    const projectRoot = createBoundaryProject();
    const project = boundaryProject();
    verifyAuthoringChange(projectRoot, project);

    writeFileSync(join(projectRoot, "provider-failure"), "fail\n");
    const failed = verifyAuthoringChange(projectRoot, project);
    expect(resultStates(failed.results)).toEqual({
      "policy:check": "failed",
      "policy:build": "blocked",
      "consumer:test": "blocked",
      "authorization:live": "blocked",
    });
    expect(failed.ok).toBe(false);

    rmSync(join(projectRoot, "provider-failure"));
    const full = verifyTaskGraph({
      projectRoot,
      project,
      recommendation: recommendChangedVerification(project, ["authoring.txt"]),
      full: true,
      captureOutput: true,
    });
    expect(resultStates(full.results)).toEqual({
      "policy:check": "executed",
      "policy:build": "executed",
      "consumer:test": "executed",
      "authorization:live": "executed",
    });
  });

  it("reruns when evidence is missing or corrupt and fails closed on an invalid graph", () => {
    const projectRoot = createBoundaryProject();
    const project = boundaryProject();
    verifyAuthoringChange(projectRoot, project);

    writeFileSync(findConsumerReceipt(projectRoot), "{corrupt\n");

    const corruptEvidence = verifyAuthoringChange(projectRoot, project);
    expect(resultStates(corruptEvidence.results)["consumer:test"]).toBe(
      "executed",
    );

    const invalidProject = boundaryProject({ cycle: true });
    const invalidRecommendation = recommendChangedVerification(invalidProject, [
      "authoring.txt",
    ]);
    expect(invalidRecommendation.complete).toBe(false);
    const invalid = verifyTaskGraph({
      projectRoot,
      project: invalidProject,
      recommendation: invalidRecommendation,
      full: false,
      captureOutput: true,
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.results.every((result) => result.status === "blocked")).toBe(
      true,
    );

    const unknownScope = verifyTaskGraph({
      projectRoot,
      project,
      recommendation: recommendChangedVerification(project, [
        "tools/unknown-input.mjs",
      ]),
      full: false,
      captureOutput: true,
    });
    expect(unknownScope.ok).toBe(true);
    expect(resultStates(unknownScope.results)["consumer:test"]).toBe(
      "executed",
    );
  });

  it("removes invalid evidence instead of leaving it to be read again", () => {
    const projectRoot = createBoundaryProject();
    const project = boundaryProject();
    verifyAuthoringChange(projectRoot, project);
    const consumerReceipt = findConsumerReceipt(projectRoot);
    writeFileSync(consumerReceipt, "{corrupt\n");

    const report = verifyAuthoringChange(projectRoot, project);

    expect(resultStates(report.results)["consumer:test"]).toBe("executed");
    const republished: unknown = JSON.parse(
      readFileSync(consumerReceipt, "utf8"),
    );
    expect(republished).toMatchObject({ taskId: "consumer:test" });
  });

  it("refuses a captured manifest that does not match the planned task graph", () => {
    const projectRoot = createBoundaryProject();
    writeFileSync(
      join(projectRoot, "dads.project.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        packages: [
          {
            name: "other",
            root: "authoring.txt",
            responsibility: "Declares a different graph.",
            allowedDependencies: [],
            verification: [],
            skills: [],
          },
        ],
      })}\n`,
    );

    const report = verifyAuthoringChange(projectRoot, boundaryProject());

    expect(report.ok).toBe(false);
    expect(report.results).toEqual([]);
    expect(report.issues).toEqual([
      "Captured manifest does not match the planned task graph.",
    ]);
  });

  it("publishes nothing when any task in the graph fails", () => {
    const projectRoot = createBoundaryProject();
    const project = boundaryProject();
    verifyAuthoringChange(projectRoot, project);
    const publishedPath = join(projectRoot, "generated/policy.json");
    const published = readFileSync(publishedPath, "utf8");
    writeFileSync(join(projectRoot, "authoring.txt"), "writer\n");
    writeFileSync(join(projectRoot, "live.mjs"), "process.exit(5);\n");

    const report = verifyAuthoringChange(projectRoot, project);

    expect(report.ok).toBe(false);
    expect(resultStates(report.results)["authorization:live"]).toBe("failed");
    expect(readFileSync(publishedPath, "utf8")).toBe(published);
  });

  it("requires schema version 3 for controlled execution semantics", () => {
    const versionThree = boundaryProjectInput();

    expect(() =>
      parseDadsProject({ ...versionThree, schemaVersion: 2 }),
    ).toThrow(/schemaVersion 3/i);
  });

  it("rejects self-declared controlled runners outside the mechanical adapter contract", () => {
    const input = boundaryProjectInput();
    const policyBuild = input.verification.tasks[1];
    if (!policyBuild || policyBuild.execution.kind !== "controlled-node") {
      throw new Error("Expected controlled provider fixture.");
    }

    expect(() =>
      parseDadsProject({
        ...input,
        verification: {
          ...input.verification,
          tasks: [
            input.verification.tasks[0],
            {
              ...policyBuild,
              execution: {
                ...policyBuild.execution,
                adapter: "arbitrary-node",
              },
            },
            ...input.verification.tasks.slice(2),
          ],
        },
      }),
    ).toThrow(/controlled verification adapter/i);
  });

  it("reports an empty selected scope as not applicable", () => {
    const projectRoot = createBoundaryProject();
    const project = boundaryProject();
    const report = verifyTaskGraph({
      projectRoot,
      project,
      recommendation: recommendChangedVerification(project, []),
      full: false,
      captureOutput: true,
    });

    expect(report.ok).toBe(true);
    expect(report.counts["not-applicable"]).toBe(1);
    expect(formatVerificationReport(report)).toMatch(/not-applicable/i);
  });

  it("fails the graph when the live checkout changes during isolated execution", () => {
    const projectRoot = createBoundaryProject();
    writeFileSync(
      join(projectRoot, "provider-check.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(projectRoot, "authoring.txt"))}, "changed-live\\n");\n`,
    );

    const report = verifyAuthoringChange(projectRoot, boundaryProject());

    expect(report.ok).toBe(false);
    expect(report.issues).toContain(
      "Checkout identity changed while verification was running.",
    );
  });

  it("rejects consumed artifact bytes that differ from the producer fingerprint", () => {
    const projectRoot = createBoundaryProject();
    const project = boundaryProject({ tamperArtifact: true });

    const report = verifyAuthoringChange(projectRoot, project);

    expect(resultStates(report.results)["consumer:test"]).toBe("failed");
    expect(
      report.results.find((result) => result.taskId === "consumer:test")
        ?.reason,
    ).toMatch(/does not match producer/i);
  });

  it("preserves internal symlinks and rejects graph inputs outside the workspace", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "dads-workspace-links-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "dads-external-link-"));
    temporaryProjects.push(projectRoot, externalRoot);
    mkdirSync(join(projectRoot, "internal"));
    writeFileSync(join(projectRoot, "internal/input.txt"), "inside\n");
    symlinkSync("internal", join(projectRoot, "internal-link"), "dir");

    const identity = readWorkspaceIdentity(projectRoot);
    const snapshot = captureWorkspaceSnapshot(projectRoot, identity);
    expect(
      lstatSync(join(snapshot.root, "internal-link")).isSymbolicLink(),
    ).toBe(true);
    discardWorkspaceSnapshot(snapshot);

    writeFileSync(join(externalRoot, "outside.txt"), "outside\n");
    symlinkSync(
      join(externalRoot, "outside.txt"),
      join(projectRoot, "outside-link"),
    );

    expect(() => readWorkspaceIdentity(projectRoot)).toThrow(/outside/i);
  });

  it("captures a stable workspace identity while a tracked file is deleted", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "dads-workspace-delete-"));
    temporaryProjects.push(projectRoot);
    writeFileSync(join(projectRoot, "tracked.txt"), "tracked\n");
    runGit(projectRoot, ["init"]);
    runGit(projectRoot, ["add", "tracked.txt"]);
    rmSync(join(projectRoot, "tracked.txt"));

    const deletedIdentity = readWorkspaceIdentity(projectRoot);
    const snapshot = captureWorkspaceSnapshot(projectRoot, deletedIdentity);
    expect(existsSync(join(snapshot.root, "tracked.txt"))).toBe(false);
    discardWorkspaceSnapshot(snapshot);

    writeFileSync(join(projectRoot, "tracked.txt"), "tracked\n");
    expect(readWorkspaceIdentity(projectRoot)).not.toBe(deletedIdentity);
  });
});

function runGit(projectRoot: string, argumentsAfterGit: readonly string[]) {
  const completed = spawnSync("git", argumentsAfterGit, {
    cwd: projectRoot,
    encoding: "utf8",
    env: environmentWithoutGitVariables(),
  });
  if (completed.status !== 0) {
    throw new Error(
      `Git failed: ${completed.stderr.trim() || completed.stdout.trim()}`,
    );
  }
}

function verifyAuthoringChange(
  projectRoot: string,
  project: ReturnType<typeof boundaryProject>,
) {
  return verifyTaskGraph({
    projectRoot,
    project,
    recommendation: recommendChangedVerification(project, ["authoring.txt"]),
    full: false,
    captureOutput: true,
  });
}

function verifyConsumerChange(
  projectRoot: string,
  project: ReturnType<typeof boundaryProject>,
  changedPath: string,
) {
  return verifyTaskGraph({
    projectRoot,
    project,
    recommendation: recommendChangedVerification(project, [changedPath]),
    full: false,
    captureOutput: true,
  });
}

function resultStates(
  results: readonly VerificationTaskResult[],
): Readonly<Record<string, VerificationTaskResult["status"]>> {
  return Object.fromEntries(
    results.map((result) => [result.taskId, result.status]),
  );
}

function boundaryProject(
  options: {
    readonly cycle?: boolean;
    readonly consumerEnvironment?: string;
    readonly consumerRunnerVersion?: string;
    readonly tamperArtifact?: boolean;
  } = {},
) {
  return parseDadsProject(boundaryProjectInput(options));
}

function boundaryProjectInput(
  options: {
    readonly cycle?: boolean;
    readonly consumerEnvironment?: string;
    readonly consumerRunnerVersion?: string;
    readonly tamperArtifact?: boolean;
  } = {},
) {
  return {
    schemaVersion: 3,
    packages: [
      {
        name: "boundary",
        root: "authoring.txt",
        responsibility: "Proves exact artifact verification.",
        allowedDependencies: [],
        verification: [],
        skills: ["dads-orient"],
      },
    ],
    verification: {
      projectId: "boundary-verification-test",
      tasks: [
        {
          id: "policy:check",
          packageName: "boundary",
          command: "node provider-check.mjs",
          dependsOn: options.cycle ? ["consumer:test"] : [],
          sourceInputs: ["authoring.txt"],
          nonSourceInputs: ["provider-check.mjs"],
          reusePolicy: "never",
          execution: { kind: "shell" },
        },
        {
          id: "policy:build",
          packageName: "boundary",
          command: "node provider.mjs",
          dependsOn: ["policy:check"],
          sourceInputs: ["authoring.txt"],
          nonSourceInputs: ["provider.mjs"],
          reusePolicy: "never",
          execution: controlledExecution({
            runnerEntrypoint: "provider.mjs",
            inputFiles: [
              { path: "authoring.txt", role: "source" },
              { path: "provider.mjs", role: "test" },
            ],
            outputFiles: ["policy.json"],
            publishOutputs: [
              {
                outputPath: "policy.json",
                projectPath: "generated/policy.json",
              },
            ],
          }),
        },
        {
          id: "consumer:test",
          packageName: "boundary",
          command: "node consumer.mjs",
          dependsOn: [
            "policy:build",
            ...(options.tamperArtifact ? ["artifact:tamper"] : []),
          ],
          sourceInputs: ["consumer-source.txt", "consumer.test.txt"],
          nonSourceInputs: [
            "consumer.config.json",
            "engine.mjs",
            "binding.mjs",
            "toolchain.lock",
          ],
          reusePolicy: "candidate",
          execution: controlledExecution({
            runnerEntrypoint: "consumer.mjs",
            runnerVersion:
              options.consumerRunnerVersion ?? "boundary-runner-v1",
            inputFiles: [
              { path: "consumer.mjs", role: "test" },
              { path: "consumer-source.txt", role: "source" },
              { path: "consumer.test.txt", role: "test" },
              { path: "consumer.config.json", role: "configuration" },
              { path: "engine.mjs", role: "resolved-dependency" },
              { path: "binding.mjs", role: "resolved-dependency" },
              { path: "toolchain.lock", role: "configuration" },
              { path: "generated/policy.json", role: "artifact" },
            ],
            outputFiles: ["consumer-result.json"],
            prerequisiteOutputTaskIds: ["policy:build"],
            environmentValue: options.consumerEnvironment ?? "test",
          }),
        },
        ...(options.tamperArtifact
          ? [
              {
                id: "artifact:tamper",
                packageName: "boundary",
                command: "node tamper.mjs",
                dependsOn: ["policy:build"],
                sourceInputs: ["tamper.mjs"],
                nonSourceInputs: [],
                reusePolicy: "never",
                execution: { kind: "shell" },
              },
            ]
          : []),
        {
          id: "authorization:live",
          packageName: "boundary",
          command: "node live.mjs",
          dependsOn: ["policy:build"],
          sourceInputs: ["live.mjs"],
          nonSourceInputs: [],
          reusePolicy: "never",
          execution: { kind: "shell" },
        },
      ],
      fullFallbackTaskIds: [
        "policy:check",
        "policy:build",
        "consumer:test",
        "authorization:live",
      ],
    },
  };
}

function controlledExecution(options: {
  readonly runnerEntrypoint: string;
  readonly inputFiles: readonly VerificationControlledInput[];
  readonly outputFiles: readonly string[];
  readonly runnerVersion?: string;
  readonly publishOutputs?: readonly {
    readonly outputPath: string;
    readonly projectPath: string;
  }[];
  readonly prerequisiteOutputTaskIds?: readonly string[];
  readonly environmentValue?: string;
}): VerificationControlledExecution {
  return {
    kind: "controlled-node",
    adapter:
      (options.prerequisiteOutputTaskIds ?? []).length === 0
        ? "artifact-provider-v1"
        : "artifact-consumer-v1",
    workingDirectory: ".",
    runnerEntrypoint: options.runnerEntrypoint,
    runnerArguments: [],
    runnerVersion: options.runnerVersion ?? "boundary-runner-v1",
    inputFiles: options.inputFiles,
    outputFiles: options.outputFiles,
    publishOutputs: options.publishOutputs ?? [],
    environment: [
      {
        name: "BOUNDARY_MODE",
        value: options.environmentValue ?? "test",
        secret: false,
      },
    ],
    prerequisiteOutputTaskIds: options.prerequisiteOutputTaskIds ?? [],
    timeoutMilliseconds: 5_000,
  };
}

function createBoundaryProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "dads-boundary-graph-"));
  temporaryProjects.push(projectRoot);
  mkdirSync(join(projectRoot, "generated"));
  writeFileSync(join(projectRoot, "authoring.txt"), "reader\n");
  writeFileSync(
    join(projectRoot, "provider-check.mjs"),
    'import { existsSync } from "node:fs"; if (existsSync("provider-failure")) process.exit(3);\n',
  );
  writeFileSync(
    join(projectRoot, "provider.mjs"),
    'import { readFileSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const policy = readFileSync("authoring.txt", "utf8").split("\\n").filter((line) => line.length > 0 && !line.startsWith("#")).join("\\n"); writeFileSync(join(process.env["DADS_VERIFICATION_OUTPUT_DIR"], "policy.json"), `${policy}\\n`);\n',
  );
  writeFileSync(
    join(projectRoot, "consumer.mjs"),
    'import { readFileSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const policy = readFileSync("generated/policy.json", "utf8"); if (policy.length === 0) process.exit(4); writeFileSync(join(process.env["DADS_VERIFICATION_OUTPUT_DIR"], "consumer-result.json"), JSON.stringify({ policy }));\n',
  );
  writeFileSync(join(projectRoot, "live.mjs"), "process.exit(0);\n");
  writeFileSync(
    join(projectRoot, "tamper.mjs"),
    'import { writeFileSync } from "node:fs"; writeFileSync("generated/policy.json", "tampered\\n");\n',
  );
  for (const input of [
    "consumer-source.txt",
    "consumer.test.txt",
    "consumer.config.json",
    "engine.mjs",
    "binding.mjs",
    "toolchain.lock",
  ]) {
    writeFileSync(join(projectRoot, input), `${input}:baseline\n`);
  }
  return projectRoot;
}

function findConsumerReceipt(projectRoot: string): string {
  const receiptPath = listFiles(
    join(projectRoot, ".dads", "verification", "receipts"),
  ).find((file) => readFileSync(file, "utf8").includes('"consumer:test"'));
  if (!receiptPath)
    throw new Error("Expected a consumer verification receipt.");
  return receiptPath;
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}
