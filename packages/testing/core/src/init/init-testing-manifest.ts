import { createHash, randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { resolveNativeTestingBinary } from "../native-platform.js";
import { planTesting } from "../testing-api.js";
import {
  defaultTestingManifestFileName,
  serializeTestingManifest,
  type TestingManifest,
} from "../testing-manifest.js";
import {
  writeFilesAtomically,
  type FileOutput,
} from "../write-files-atomically.js";
import { checkTestingManifest } from "./check-testing-manifest.js";
import { describeError } from "./describe-error.js";
import { detectWorkspace } from "./detect-workspace.js";
import {
  inferTestingManifest,
  type InitReport,
  type InitValidation,
} from "./infer-testing-manifest.js";
import { readWorkspacePackages } from "./package-inventory.js";
import { workspaceRelative } from "./workspace-relative-path.js";

/**
 * Generates `dads.testing.json` for a workspace that does not have one, and the
 * report that explains it. A manifest only reaches its final path once it has
 * been checked: structurally always, and by the native engine itself where one
 * is installed. Nothing partly-valid is left behind for the next command to
 * trip over, and an existing manifest is never replaced without `--force`.
 */

export type InitTestingManifestOptions = {
  readonly workspaceRoot: string;
  readonly manifestPath?: string;
  readonly force?: boolean;
  /** An explicit native binary is intended for local development and test harnesses. */
  readonly nativeBinary?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Overrides how the native engine is found; undefined means "not installed". */
  readonly resolveNativeBinary?: () => string | undefined;
};

export type InitTestingManifestResult = {
  /** Workspace-relative path of the manifest that was written. */
  readonly manifestPath: string;
  /** Workspace-relative path of the report that explains it. */
  readonly reportPath: string;
  readonly manifest: TestingManifest;
  readonly report: InitReport;
};

export const initReportFileName = "dads.testing.init-report.json";

const noRecognizedScripts =
  "No recognized test, typecheck, lint, or build scripts were found";

/** Where the two generated files go, named both absolutely and as the result reports them. */
type InitPaths = {
  readonly workspaceRoot: string;
  readonly manifestFile: string;
  readonly reportFile: string;
  readonly manifestPath: string;
  readonly reportPath: string;
};

/** Finishes the report with the validation that was actually performed. */
type BuildReport = (
  validation: InitValidation,
  manifestChecksum: string | null,
) => { readonly report: InitReport; readonly output: FileOutput };

export async function initTestingManifest(
  options: InitTestingManifestOptions,
): Promise<InitTestingManifestResult> {
  const paths = resolveInitPaths(options);

  // Checked before anything is generated: a refusal must not touch the report.
  if (existsSync(paths.manifestFile) && options.force !== true) {
    throw new Error(
      `Refusing to overwrite existing ${paths.manifestPath}; pass --force to replace it.`,
    );
  }

  const workspace = detectWorkspace(paths.workspaceRoot);
  const packages = readWorkspacePackages(
    paths.workspaceRoot,
    workspace.packageDirectories,
  );
  const inferred = inferTestingManifest(workspace, packages);
  const buildReport = reportBuilder(inferred.report, paths.reportFile);

  requireStandaloneWorkspace(
    paths.workspaceRoot,
    paths.reportFile,
    inferred.report,
  );
  const manifest = requireInferredManifest(inferred.manifest, buildReport);
  const manifestText = requireStructurallyValid(manifest, buildReport);
  const checksum = createHash("sha256").update(manifestText).digest("hex");
  const nativeBinary = (
    options.resolveNativeBinary ?? installedNativeBinary(options)
  )();

  const report =
    nativeBinary === undefined
      ? writeStructurallyChecked(paths, manifestText, checksum, buildReport)
      : await writeEngineChecked({
          paths,
          manifestText,
          nativeBinary,
          checksum,
          buildReport,
        });
  return {
    manifestPath: paths.manifestPath,
    reportPath: paths.reportPath,
    manifest,
    report,
  };
}

/** The report is written beside the manifest, and neither may leave the workspace. */
function resolveInitPaths(options: InitTestingManifestOptions): InitPaths {
  const workspaceRoot = resolve(options.workspaceRoot);
  const requestedPath = options.manifestPath ?? defaultTestingManifestFileName;
  const manifestFile = resolve(workspaceRoot, requestedPath);
  if (
    manifestFile !== workspaceRoot &&
    !manifestFile.startsWith(`${workspaceRoot}${sep}`)
  ) {
    throw new Error(
      `The manifest path must stay inside the workspace: ${requestedPath}`,
    );
  }
  const reportFile = join(dirname(manifestFile), initReportFileName);
  return {
    workspaceRoot,
    manifestFile,
    reportFile,
    manifestPath: workspaceRelative(workspaceRoot, manifestFile),
    reportPath: workspaceRelative(workspaceRoot, reportFile),
  };
}

function reportBuilder(
  inferredReport: Omit<InitReport, "validation" | "manifestChecksum">,
  reportFile: string,
): BuildReport {
  return (validation, manifestChecksum) => {
    const report: InitReport = {
      ...inferredReport,
      validation,
      manifestChecksum,
    };
    return {
      report,
      output: {
        path: reportFile,
        contents: `${JSON.stringify(report, null, 2)}\n`,
      },
    };
  };
}

/** A workspace with nothing to run still gets the report that says so. */
function requireInferredManifest(
  manifest: TestingManifest | undefined,
  buildReport: BuildReport,
): TestingManifest {
  if (manifest !== undefined) return manifest;
  writeFilesAtomically([
    buildReport(
      { method: "none", ok: false, messages: [`${noRecognizedScripts}.`] },
      null,
    ).output,
  ]);
  throw new Error(
    `${noRecognizedScripts}; wrote ${initReportFileName} and no manifest.`,
  );
}

/** Serialized only once it has passed, so the text that reaches disk is the text checked. */
function requireStructurallyValid(
  manifest: TestingManifest,
  buildReport: BuildReport,
): string {
  const structuralMessages = checkTestingManifest(manifest);
  if (structuralMessages.length === 0) {
    return serializeTestingManifest(manifest);
  }
  writeFilesAtomically([
    buildReport(
      { method: "structural", ok: false, messages: structuralMessages },
      null,
    ).output,
  ]);
  throw new Error(
    `Generated manifest failed validation: ${structuralMessages.join(" ")}`,
  );
}

/** Without an engine to ask, the structural check is the whole check. */
function writeStructurallyChecked(
  paths: InitPaths,
  manifestText: string,
  checksum: string,
  buildReport: BuildReport,
): InitReport {
  const written = buildReport(
    { method: "structural", ok: true, messages: [] },
    checksum,
  );
  writeFilesAtomically([
    { path: paths.manifestFile, contents: manifestText },
    written.output,
  ]);
  return written.report;
}

/** The engine's acceptance is what moves the manifest into place, so only the report is left. */
async function writeEngineChecked(request: {
  readonly paths: InitPaths;
  readonly manifestText: string;
  readonly nativeBinary: string;
  readonly checksum: string;
  readonly buildReport: BuildReport;
}): Promise<InitReport> {
  const buildReport = request.buildReport;
  const selectedTaskCount = await validateWithNativeEngine({
    workspaceRoot: request.paths.workspaceRoot,
    manifestFile: request.paths.manifestFile,
    manifestText: request.manifestText,
    nativeBinary: request.nativeBinary,
    onRejected: (message, error) => {
      writeFilesAtomically([
        buildReport({ method: "native", ok: false, messages: [message] }, null)
          .output,
      ]);
      return new Error(
        `Generated manifest was rejected by dad-test: ${message}`,
        {
          cause: error,
        },
      );
    },
  });

  const written = buildReport(
    { method: "native", ok: true, messages: [], selectedTaskCount },
    request.checksum,
  );
  writeFilesAtomically([written.output]);
  return written.report;
}

function requireStandaloneWorkspace(
  workspaceRoot: string,
  reportFile: string,
  inferredReport: Omit<InitReport, "validation" | "manifestChecksum">,
): void {
  if (!existsSync(join(workspaceRoot, "nx.json"))) return;
  const message =
    "Nx workspace detected. Generic script discovery cannot establish Nx target coverage; use @dads-framework/testing-import-nx and review its coverage report.";
  const report: InitReport = {
    ...inferredReport,
    validation: { method: "none", ok: false, messages: [message] },
    manifestChecksum: null,
    unsupported: [
      ...inferredReport.unsupported,
      { subject: "nx.json", message },
    ],
  };
  writeFilesAtomically([
    { path: reportFile, contents: `${JSON.stringify(report, null, 2)}\n` },
  ]);
  throw new Error(`${message} No manifest was written.`);
}

/**
 * Asks the engine that will run this manifest whether it accepts it, by
 * planning a full run against a temporary copy inside the workspace. The copy
 * becomes the manifest only once the engine has read it, so a rejected manifest
 * is never a file anyone can run.
 */
async function validateWithNativeEngine(request: {
  readonly workspaceRoot: string;
  readonly manifestFile: string;
  readonly manifestText: string;
  readonly nativeBinary: string;
  readonly onRejected: (message: string, error: unknown) => Error;
}): Promise<number> {
  const temporaryFile = `${request.manifestFile}.${randomUUID()}.tmp`;
  writeFileSync(temporaryFile, request.manifestText, "utf8");
  let selectedTaskCount: number;
  try {
    const plan = await planTesting({
      workspaceRoot: request.workspaceRoot,
      manifestPath: workspaceRelative(request.workspaceRoot, temporaryFile),
      all: true,
      taskIds: [],
      nativeBinary: request.nativeBinary,
    });
    selectedTaskCount = plan.counts.run;
  } catch (error: unknown) {
    rmSync(temporaryFile, { force: true });
    throw request.onRejected(describeError(error), error);
  }
  try {
    renameSync(temporaryFile, request.manifestFile);
  } catch (error: unknown) {
    rmSync(temporaryFile, { force: true });
    throw error;
  }
  return selectedTaskCount;
}

/**
 * A workspace without the native package still generates a manifest: the
 * structural check is the same set of rules. Any resolution failure means "not
 * installed here", which is a supported state rather than an error.
 */
function installedNativeBinary(
  options: InitTestingManifestOptions,
): () => string | undefined {
  return () => {
    try {
      return resolveNativeTestingBinary({
        ...(options.nativeBinary === undefined
          ? {}
          : { explicitBinary: options.nativeBinary }),
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
      }).binary;
    } catch {
      return undefined;
    }
  };
}
