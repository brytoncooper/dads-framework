import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { VerificationTaskRecommendation } from "./verification-contract.js";
import {
  assertSnapshotMatchesIdentity,
  capturedSnapshotMatchesProject,
  captureVerificationSnapshot,
  type CapturedVerificationSnapshot,
  type ControlledVerificationRequest,
  discardVerificationSnapshot,
  verificationEnvironment,
} from "./verification-inputs.js";
import { createVerificationReceiptStore, publishSuccessfulVerificationReceipt } from "./receipt-store.js";
import { errorMessage } from "./verification-failure.js";
import { sanitizedGitEnvironment } from "./workspace-git-context.js";
import type {
  ControlledVerificationExecution,
  SuccessfulVerificationReceipt,
  VerificationOutputFingerprint,
} from "./verification-receipt.js";

export type VerificationTaskExecution = {
  readonly taskId: string;
  readonly command: string;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: string | undefined;
};

export type ReusableVerificationExecution =
  | {
      readonly status: "succeeded";
      readonly execution: ControlledVerificationExecution;
      readonly receipt: SuccessfulVerificationReceipt;
    }
  | {
      readonly status: "failed";
      readonly execution: ControlledVerificationExecution;
    }
  | {
      readonly status: "stale";
      readonly execution: ControlledVerificationExecution;
      readonly receipt: SuccessfulVerificationReceipt;
    };

export function runVerificationTask(
  projectRoot: string,
  task: VerificationTaskRecommendation,
  captureOutput: boolean,
): VerificationTaskExecution {
  const completed = spawnSync(task.command, {
    cwd: projectRoot,
    shell: true,
    encoding: "utf8",
    env: sanitizedGitEnvironment(),
    stdio: captureOutput ? "pipe" : "inherit",
  });
  return {
    taskId: task.taskId,
    command: task.command,
    passed: !completed.error && completed.status === 0,
    exitCode: completed.status,
    signal: completed.signal,
    error: readCommandFailure(completed),
  };
}

export function runCapturedVerification(snapshot: CapturedVerificationSnapshot): ControlledVerificationExecution {
  try {
    assertSnapshotMatchesIdentity(snapshot.snapshotRoot, snapshot.identity);
    assertAllowedControlledImports(snapshot);
  } catch (error: unknown) {
    return failedCapturedExecution(snapshot, undefined, errorMessage(error));
  }

  const completed = spawnSync(
    process.execPath,
    [
      permissionModelOption(),
      ...snapshot.identity.files.map(
        (file) => `--allow-fs-read=${resolveSnapshotPath(snapshot.snapshotRoot, file.path)}`,
      ),
      `--allow-fs-write=${snapshot.outputRoot}`,
      ...moduleDefaultTypeOptions(),
      "--input-type=module",
      "--eval",
      controlledBootstrap(),
      pathToFileURL(resolveSnapshotPath(snapshot.snapshotRoot, snapshot.identity.command.entrypoint)).href,
    ],
    {
      cwd:
        snapshot.identity.command.workingDirectory === "."
          ? snapshot.snapshotRoot
          : resolveSnapshotPath(snapshot.snapshotRoot, snapshot.identity.command.workingDirectory),
      encoding: "utf8",
      env: verificationEnvironment(snapshot),
      stdio: "pipe",
      timeout: snapshot.timeoutMilliseconds,
      killSignal: "SIGTERM",
    },
  );

  try {
    assertSnapshotMatchesIdentity(snapshot.snapshotRoot, snapshot.identity);
  } catch (error: unknown) {
    return failedCapturedExecution(snapshot, completed, errorMessage(error));
  }
  if (completed.error || completed.status !== 0 || completed.signal) {
    return failedCapturedExecution(snapshot, completed, readCapturedFailure(completed));
  }
  try {
    const outputs = fingerprintVerificationOutputs(snapshot);
    return {
      snapshotId: snapshot.identity.snapshotId,
      identity: snapshot.identity,
      status: "succeeded",
      exitCode: completed.status,
      signal: completed.signal,
      failure: undefined,
      outputs,
    };
  } catch (error: unknown) {
    return failedCapturedExecution(snapshot, completed, errorMessage(error));
  }
}

/** Node renamed --experimental-permission to --permission; pass whichever spelling this runtime accepts. */
function permissionModelOption(): string {
  if (nodeSupportsOption("--permission")) return "--permission";
  if (nodeSupportsOption("--experimental-permission")) {
    return "--experimental-permission";
  }
  throw new Error("Controlled verification requires a Node.js runtime with the permission model.");
}

/** Newer Node detects module syntax itself and rejects the default-type flag; pass it only where it still exists. */
function moduleDefaultTypeOptions(): readonly string[] {
  return nodeSupportsOption("--experimental-default-type=module") ? ["--experimental-default-type=module"] : [];
}

const supportedNodeOptions = new Map<string, boolean>();

function nodeSupportsOption(option: string): boolean {
  const knownSupport = supportedNodeOptions.get(option);
  if (knownSupport !== undefined) return knownSupport;
  const completed = spawnSync(process.execPath, [option, "--version"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const supported = !completed.error && completed.status === 0;
  supportedNodeOptions.set(option, supported);
  return supported;
}

function controlledBootstrap(): string {
  return [
    "const denied = (name) => () => { throw new Error(`Controlled verification cannot use ${name}.`); };",
    'globalThis.fetch = denied("network access");',
    'globalThis.WebSocket = class { constructor() { throw new Error("Controlled verification cannot use network access."); } };',
    'globalThis.Date = class extends Date { constructor(...args) { if (args.length === 0) throw new Error("Controlled verification cannot read time."); super(...args); } static now() { throw new Error("Controlled verification cannot read time."); } };',
    'Object.defineProperty(Math, "random", { value: denied("randomness") });',
    'if (globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: undefined });',
    'globalThis.setTimeout = denied("timers");',
    'globalThis.setInterval = denied("timers");',
    'const filesystem = (await import("node:fs")).default;',
    'for (const name of ["stat", "statSync", "lstat", "lstatSync", "fstat", "fstatSync"]) Object.defineProperty(filesystem, name, { value: denied("filesystem metadata") });',
    'for (const name of ["stat", "lstat"]) Object.defineProperty(filesystem.promises, name, { value: denied("filesystem metadata") });',
    'const { syncBuiltinESMExports } = await import("node:module");',
    "syncBuiltinESMExports();",
    'for (const name of ["hrtime", "uptime", "cpuUsage", "resourceUsage"]) Object.defineProperty(process, name, { value: denied("ambient process state") });',
    'for (const name of ["pid", "ppid"]) Object.defineProperty(process, name, { get: denied("ambient process identity") });',
    'if (globalThis.performance) Object.defineProperty(globalThis, "performance", { value: undefined });',
    "await import(process.argv[1]);",
  ].join("\n");
}

const allowedControlledBuiltins = new Set(["node:assert", "node:assert/strict", "node:fs", "node:path"]);

function assertAllowedControlledImports(snapshot: CapturedVerificationSnapshot): void {
  for (const file of snapshot.identity.files) {
    if (!/\.[cm]?js$/.test(file.path)) continue;
    assertAllowedModuleSource(readFileSync(resolveSnapshotPath(snapshot.snapshotRoot, file.path), "utf8"));
  }
}

function assertAllowedModuleSource(source: string): void {
  for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)) {
    const specifier = match[2];
    if (specifier) assertAllowedImportSpecifier(specifier);
  }
  if (/import\s*\((?!\s*["'])/.test(source)) {
    throw new Error("Controlled verification dynamic imports must be literal.");
  }
}

function assertAllowedImportSpecifier(specifier: string): void {
  if (specifier.startsWith("node:")) {
    if (allowedControlledBuiltins.has(specifier)) return;
    throw new Error(`Controlled verification import is not allowlisted: ${specifier}.`);
  }
  if (!specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("file:")) {
    throw new Error(`Controlled verification package import is not allowlisted: ${specifier}.`);
  }
}

export function runReusableVerificationTask(request: ControlledVerificationRequest): ReusableVerificationExecution {
  const snapshot = captureVerificationSnapshot(request);
  try {
    const execution = runCapturedVerification(snapshot);
    if (execution.status === "failed") return { status: "failed", execution };
    try {
      assertSnapshotMatchesIdentity(snapshot.snapshotRoot, snapshot.identity);
    } catch (error: unknown) {
      return {
        status: "failed",
        execution: failedCapturedExecution(snapshot, undefined, errorMessage(error)),
      };
    }
    const projectMatchedBeforePublication = capturedSnapshotMatchesProject(snapshot);
    const receipt = publishSuccessfulVerificationReceipt(
      createVerificationReceiptStore(request.projectRoot),
      execution,
    );
    if (!projectMatchedBeforePublication || !capturedSnapshotMatchesProject(snapshot)) {
      return { status: "stale", execution, receipt };
    }
    return { status: "succeeded", execution, receipt };
  } finally {
    discardVerificationSnapshot(snapshot);
  }
}

function readCommandFailure(completed: ReturnType<typeof spawnSync>): string | undefined {
  if (completed.error) return completed.error.message;
  if (completed.status === 0) return undefined;
  const output = [completed.stderr, completed.stdout]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim();
  if (output.length > 0) return output;
  if (completed.signal) return `Terminated by ${completed.signal}.`;
  return `Exited with status ${String(completed.status ?? "unknown")}.`;
}

function fingerprintVerificationOutputs(
  snapshot: CapturedVerificationSnapshot,
): readonly VerificationOutputFingerprint[] {
  const actualOutputPaths = listOutputFiles(snapshot.outputRoot).sort();
  if (JSON.stringify(actualOutputPaths) !== JSON.stringify(snapshot.identity.outputFiles)) {
    throw new Error("Controlled verification produced an unexpected output set.");
  }
  return actualOutputPaths.map((outputPath) => {
    const absolutePath = resolveSnapshotPath(snapshot.outputRoot, outputPath);
    const status = lstatSync(absolutePath);
    if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
      throw new Error(`Verification output is unsafe: ${outputPath}.`);
    }
    const contents = readFileSync(absolutePath);
    return {
      path: outputPath,
      sha256: createHash("sha256").update(contents).digest("hex"),
      bytes: contents.byteLength,
    };
  });
}

function listOutputFiles(root: string, directory = root): string[] {
  const outputPaths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("Controlled verification outputs cannot contain symlinks.");
    }
    if (entry.isDirectory()) {
      outputPaths.push(...listOutputFiles(root, absolutePath));
    } else if (entry.isFile()) {
      outputPaths.push(relative(root, absolutePath).split(sep).join("/"));
    } else {
      throw new Error("Controlled verification produced an unsupported output.");
    }
  }
  return outputPaths;
}

function resolveSnapshotPath(root: string, relativePath: string): string {
  const absolutePath = resolve(root, relativePath);
  const pathFromRoot = relative(root, absolutePath);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error(`Verification path escapes its captured root: ${relativePath}.`);
  }
  return absolutePath;
}

function failedCapturedExecution(
  snapshot: CapturedVerificationSnapshot,
  completed: ReturnType<typeof spawnSync> | undefined,
  failure: string,
): ControlledVerificationExecution {
  return {
    snapshotId: snapshot.identity.snapshotId,
    identity: snapshot.identity,
    status: "failed",
    exitCode: completed?.status ?? null,
    signal: completed?.signal ?? null,
    failure,
    outputs: [],
  };
}

function readCapturedFailure(completed: ReturnType<typeof spawnSync>): string {
  if (completed.error) return completed.error.message;
  const output = [completed.stderr, completed.stdout]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim();
  if (output.length > 0) return output;
  if (completed.signal) return `Controlled verification ended by ${completed.signal}.`;
  return `Controlled verification exited with status ${String(completed.status ?? "unknown")}.`;
}
