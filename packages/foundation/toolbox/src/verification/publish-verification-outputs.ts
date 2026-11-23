/**
 * Where a verified task's bytes are allowed to land, and what a consumer is
 * allowed to have read.
 *
 * Publication is the one moment a controlled task touches something outside
 * its own captured tree, so every write resolves inside the root it was given,
 * refuses a target that is not a plain file, and lands through a rename rather
 * than a partial overwrite. The artifact check is the same question asked
 * backwards: the bytes a consumer captured must be the bytes its provider
 * fingerprinted, or the reuse decision is built on nothing.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { DadsProject } from "../project-orientation.js";
import type { ControlledVerificationTask, VerificationPublishedOutput } from "./verification-contract.js";
import type { CapturedVerificationSnapshot } from "./verification-inputs.js";
import type { VerificationOutputFingerprint } from "./verification-receipt.js";

/**
 * Proves the consumer's captured artifact bytes came from this run's provider,
 * for every output that provider publishes.
 */
export function assertConsumedArtifactsMatchProviders(
  project: DadsProject,
  consumer: ControlledVerificationTask,
  snapshot: CapturedVerificationSnapshot,
  outputsByTask: ReadonlyMap<string, readonly VerificationOutputFingerprint[]>,
): void {
  const tasks = new Map(project.verificationPolicy.tasks.map((task) => [task.id, task]));
  for (const prerequisiteId of consumer.execution.prerequisiteOutputTaskIds) {
    const provider = tasks.get(prerequisiteId);
    const produced = outputsByTask.get(prerequisiteId);
    if (!provider || provider.execution.kind !== "controlled-node" || !produced) {
      throw new Error(`Missing artifact producer evidence for ${prerequisiteId}.`);
    }
    for (const published of provider.execution.publishOutputs) {
      const output = produced.find((fingerprint) => fingerprint.path === published.outputPath);
      const consumed = snapshot.identity.files.find(
        (fingerprint) => fingerprint.role === "artifact" && fingerprint.path === published.projectPath,
      );
      if (!output || !consumed || output.sha256 !== consumed.sha256 || output.bytes !== consumed.bytes) {
        throw new Error(`Consumed artifact ${published.projectPath} does not match producer ${prerequisiteId}.`);
      }
    }
  }
}

/** The single string that stands for everything a prerequisite task produced. */
export function outputIdentity(taskId: string, outputs: readonly VerificationOutputFingerprint[] | undefined): string {
  if (!outputs) {
    throw new Error(`Missing output identity for prerequisite ${taskId}.`);
  }
  return `${taskId}:${createHash("sha256")
    .update(JSON.stringify([...outputs].sort(compareOutputs)))
    .digest("hex")}`;
}

/** Copies a finished task's declared outputs out of its snapshot into the project. */
export function publishTaskOutputs(
  projectRoot: string,
  snapshot: CapturedVerificationSnapshot,
  publishedOutputs: readonly VerificationPublishedOutput[],
): void {
  for (const publishedOutput of publishedOutputs) {
    publishTaskOutput(projectRoot, snapshot, publishedOutput);
  }
}

/** Copies every published output of a verified graph back onto the live checkout. */
export function publishGraphOutputs(liveRoot: string, graphRoot: string, project: DadsProject): void {
  for (const task of project.verificationPolicy.tasks) {
    if (task.execution.kind !== "controlled-node") continue;
    for (const published of task.execution.publishOutputs) {
      publishGraphOutput(liveRoot, graphRoot, published);
    }
  }
}

function publishTaskOutput(
  projectRoot: string,
  snapshot: CapturedVerificationSnapshot,
  publishedOutput: VerificationPublishedOutput,
): void {
  const source = resolveOutputInside(snapshot.outputRoot, publishedOutput.outputPath);
  const target = resolveOutputInside(projectRoot, publishedOutput.projectPath);
  const sourceStatus = lstatSync(source);
  if (sourceStatus.isSymbolicLink() || !sourceStatus.isFile()) {
    throw new Error(`Controlled output is not a regular file: ${publishedOutput.outputPath}.`);
  }
  const targetDirectory = dirname(target);
  mkdirSync(targetDirectory, { recursive: true });
  assertInside(realpathSync(projectRoot), realpathSync(targetDirectory));
  assertPlainFileTarget(target, publishedOutput.projectPath);
  replaceFile(target, readFileSync(source));
}

function publishGraphOutput(liveRoot: string, graphRoot: string, published: VerificationPublishedOutput): void {
  const source = resolveOutputInside(graphRoot, published.projectPath);
  if (!existsSync(source)) return;
  const target = resolveOutputInside(liveRoot, published.projectPath);
  mkdirSync(dirname(target), { recursive: true });
  replaceFile(target, readFileSync(source));
}

function assertPlainFileTarget(target: string, projectPath: string): void {
  if (!existsSync(target)) return;
  const targetStatus = lstatSync(target);
  if (targetStatus.isSymbolicLink() || !targetStatus.isFile()) {
    throw new Error(`Published verification output is unsafe: ${projectPath}.`);
  }
}

/** Writes beside the target and renames, so a reader never sees a half-written file. */
function replaceFile(target: string, contents: Buffer): void {
  const temporaryTarget = join(dirname(target), `.dads-output-${randomUUID()}`);
  try {
    writeFileSync(temporaryTarget, contents, { flag: "wx", mode: 0o600 });
    renameSync(temporaryTarget, target);
  } finally {
    rmSync(temporaryTarget, { force: true });
  }
}

function compareOutputs(first: VerificationOutputFingerprint, second: VerificationOutputFingerprint): number {
  return first.path.localeCompare(second.path);
}

/** Resolves a published output under a root; `filesystem-guards.ts` has `resolveInside` for declared inputs. */
function resolveOutputInside(root: string, projectPath: string): string {
  const absolutePath = resolve(root, projectPath);
  assertInside(resolve(root), absolutePath);
  return absolutePath;
}

function assertInside(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error("Verification output path escapes the project root.");
  }
}
