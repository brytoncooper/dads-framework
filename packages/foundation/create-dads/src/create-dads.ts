import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  deriveDadsProjectName,
  diagnoseWorkspace,
  initializeDadsProject,
  dependenciesAreInstalled,
  parseDadsInitializationArguments,
  recordDadsDependencyInstallation,
  renderDoctorReport,
  type DadsInitializationArguments,
  type DadsProjectInitialization,
  type DoctorReport,
} from "@dads-framework/toolbox";

const PROJECT_FILE = "dads.project.json";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type CreateDadsDependencies = {
  readonly installDependencies: (projectRoot: string) => Promise<void>;
  readonly startDevelopment?: (projectRoot: string) => Promise<DadsDevelopmentUrls>;
  /**
   * Where the doctor's report is written, before anything is created. A caller
   * that only wants the report as data leaves it out and reads `doctor` on the
   * result instead.
   */
  readonly write?: (text: string) => void;
};

export type DadsDevelopmentUrls = {
  readonly webUrl: string;
  readonly apiUrl: string;
  readonly staffUrl: string;
};

export type DadsDevelopment =
  | ({ readonly status: "started" } & DadsDevelopmentUrls)
  | { readonly status: "skipped" }
  | { readonly status: "deferred"; readonly reason: string };

export type DadsProjectCreation = {
  readonly initialization: DadsProjectInitialization;
  readonly installed: boolean;
  readonly development: DadsDevelopment;
  /**
   * What the doctor read over the existing project before anything changed, or
   * `null` when there was no project to read and when `--skip-doctor` said not
   * to look.
   */
  readonly doctor: DoctorReport | null;
};

export async function createDads(
  argumentsAfterExecutable: readonly string[],
  dependencies: CreateDadsDependencies,
): Promise<DadsProjectCreation> {
  const diagnosis = readDiagnosisArguments(argumentsAfterExecutable);
  const request = parseDadsInitializationArguments(diagnosis.remaining);
  const doctor = await diagnoseBeforeCreating(request, diagnosis, dependencies);
  const projectName = request.projectName ?? deriveDadsProjectName(request.targetDirectory, request.mode);
  const initialization = initializeDadsProject({
    targetDirectory: request.targetDirectory,
    mode: request.mode,
    projectName,
    template: request.template,
    dryRun: request.dryRun,
  });
  const installed = !request.dryRun && !request.skipInstall && !dependenciesAreInstalled(initialization.projectRoot);
  if (installed) {
    await dependencies.installDependencies(initialization.projectRoot);
    recordDadsDependencyInstallation(initialization.projectRoot);
  }
  const development: DadsDevelopment =
    request.mode === "new" && !request.dryRun && !request.skipInstall
      ? await prepareDevelopment(initialization.projectRoot, dependencies.startDevelopment)
      : { status: "skipped" };
  return { initialization, installed, doctor, development };
}

async function prepareDevelopment(
  projectRoot: string,
  start: CreateDadsDependencies["startDevelopment"],
): Promise<DadsDevelopment> {
  if (start === undefined) return { status: "skipped" };
  try {
    return { status: "started", ...(await start(projectRoot)) };
  } catch (failure: unknown) {
    return {
      status: "deferred",
      reason: failure instanceof Error ? failure.message : "Development startup failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// The diagnosis
// ---------------------------------------------------------------------------

/** The two options this command answers itself, and the rest, untouched. */
type DiagnosisArguments = {
  readonly skip: boolean;
  readonly today: string | undefined;
  readonly remaining: readonly string[];
};

/**
 * Splits `--skip-doctor` and `--today` out of the argument list before the
 * initialization parser reads it. They belong to the diagnosis rather than to
 * the recipe, and the parser that owns the recipe refuses an option it does
 * not know rather than ignoring it.
 */
function readDiagnosisArguments(argumentsAfterExecutable: readonly string[]): DiagnosisArguments {
  const remaining: string[] = [];
  let skip = false;
  let today: string | undefined;
  for (let index = 0; index < argumentsAfterExecutable.length; index += 1) {
    const argument = argumentsAfterExecutable[index];
    if (argument === "--skip-doctor") {
      refuseRepeat(skip, argument);
      skip = true;
      continue;
    }
    if (argument !== "--today") {
      if (argument !== undefined) remaining.push(argument);
      continue;
    }
    refuseRepeat(today !== undefined, argument);
    today = readDate(argumentsAfterExecutable[index + 1]);
    index += 1;
  }
  return { skip, today, remaining };
}

/** Refuses an option this command was given twice, as the recipe parser does. */
function refuseRepeat(seen: boolean, option: string): void {
  if (seen) throw new Error(`Option ${option} was provided more than once.`);
}

function readDate(value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--today requires a value.");
  }
  if (!DATE.test(value)) {
    throw new Error("--today must be a date written YYYY-MM-DD.");
  }
  return value;
}

/**
 * The doctor's report over the target directory, written out before the first
 * question is asked and before the first file is written. It never fails the
 * creation: a signal that cannot answer is a line in the report, and a target
 * with no project in it is a line saying so.
 */
async function diagnoseBeforeCreating(
  request: DadsInitializationArguments,
  diagnosis: DiagnosisArguments,
  dependencies: CreateDadsDependencies,
): Promise<DoctorReport | null> {
  if (diagnosis.skip) return null;
  const root = resolve(request.targetDirectory);
  const subject = classifyTarget(root, request.mode);
  if (subject === "unrecognized") return null;
  if (subject === "fresh") {
    announce(request, dependencies, `No existing project at ${root}: skipping the doctor.\n`);
    return null;
  }
  const report = await diagnoseWorkspace({
    root,
    profile: "standard",
    ...(diagnosis.today === undefined ? {} : { today: diagnosis.today }),
  });
  announce(request, dependencies, renderDoctorReport(report));
  return report;
}

/**
 * What the target directory is, on the same rule `initializeDadsProject`
 * recognizes a project by. An existing-project run diagnoses the application it
 * is adding an isolated `dads/` project beside; a fresh run diagnoses only a
 * directory that is already a Dads project, which is the rerun. A directory
 * holding anything else is refused by initialization, so the doctor stays out
 * of the way of that refusal rather than printing a scorecard for a run that
 * is about to stop.
 */
function classifyTarget(root: string, mode: "new" | "existing"): "project" | "fresh" | "unrecognized" {
  if (!existsSync(root) || readdirSync(root).length === 0) return "fresh";
  if (mode === "existing" || existsSync(join(root, PROJECT_FILE))) return "project";
  return "unrecognized";
}

/**
 * Writes one passage of the diagnosis. A `--json` run says nothing here: its
 * whole output is the single line at the end, which carries the same report
 * under `doctor`.
 */
function announce(request: DadsInitializationArguments, dependencies: CreateDadsDependencies, text: string): void {
  if (request.json) return;
  dependencies.write?.(text);
}
