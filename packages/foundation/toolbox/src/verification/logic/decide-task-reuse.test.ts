/** Proves a matching receipt is reused only while the local cache is on. */

import { describe, expect, it } from "vitest";
import type { VerificationReceiptLookup } from "../receipt-store.js";
import type {
  VerificationTaskDefinition,
  VerificationTaskRecommendation,
} from "../verification-contract.js";
import type { VerificationInputIdentity } from "../verification-inputs.js";
import { decideTaskReuse } from "./decide-task-reuse.js";

const IDENTITY: VerificationInputIdentity = {
  formatVersion: 1,
  projectId: "project",
  taskId: "consumer:test",
  command: {
    executable: "node",
    entrypoint: "run.mjs",
    arguments: [],
    workingDirectory: ".",
  },
  runnerVersion: "v1",
  verifierSha256: "a".repeat(64),
  files: [],
  outputFiles: [],
  environmentNames: [],
  environmentSha256: "b".repeat(64),
  prerequisiteIdentities: [],
  platform: "linux",
  architecture: "x64",
  nodeVersion: "v24.0.0",
  nodeExecutableSha256: "c".repeat(64),
  timeoutMilliseconds: 1000,
  snapshotId: "d".repeat(64),
};

const MATCH: VerificationReceiptLookup = {
  status: "match",
  receipt: {
    formatVersion: 1,
    projectId: "project",
    taskId: "consumer:test",
    snapshotId: "d".repeat(64),
    identity: IDENTITY,
    outputs: [],
    completedAt: "2026-11-19T00:00:00.000Z",
    receiptId: "e".repeat(64),
  },
};

const TASK: VerificationTaskDefinition = {
  id: "consumer:test",
  packageName: "consumer",
  command: "node run.mjs",
  dependsOn: [],
  sourceInputs: [],
  nonSourceInputs: [],
  reusePolicy: "candidate",
  execution: {
    kind: "controlled-node",
    adapter: "artifact-consumer-v1",
    workingDirectory: ".",
    runnerEntrypoint: "run.mjs",
    runnerArguments: [],
    runnerVersion: "v1",
    inputFiles: [],
    outputFiles: [],
    publishOutputs: [],
    environment: [],
    prerequisiteOutputTaskIds: [],
    timeoutMilliseconds: 1000,
  },
};

const RECOMMENDATION: VerificationTaskRecommendation = {
  taskId: "consumer:test",
  packageName: "consumer",
  command: "node run.mjs",
  state: "reuse-candidate",
  reason: "inputs unchanged",
  dependsOn: [],
};

function decide(cacheOff: boolean) {
  return decideTaskReuse({
    full: false,
    cacheOff,
    task: TASK,
    recommendation: RECOMMENDATION,
    receipt: MATCH,
  });
}

describe("decideTaskReuse", () => {
  it("reuses an exact matching receipt while the cache is on", () => {
    expect(decide(false).decision).toBe("reuse");
  });

  it("executes despite a matching receipt when the cache is off", () => {
    const decision = decide(true);
    expect(decision.decision).toBe("execute");
    expect(decision.reason).toContain("--no-cache");
  });
});
