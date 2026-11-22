import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DadsProjectTemplate } from "./dads-initialization-arguments.js";
import {
  renderStarterProjectFiles,
  type StarterProjectFile,
} from "./starter-project/render-starter-project.js";
import {
  inspectAgentSkillSynchronization,
  synchronizeAgentSkills,
  type SkillSynchronizationInspection,
} from "./synchronize-agent-skills.js";

export type DadsStarterProfile = "standard" | "strict";
export type DadsClientChoice = "typescript" | "none";
export type DadsAuthorizationAdapter = "memory" | "postgres" | "spicedb";

export type InitializeDadsProjectOptions = {
  readonly targetDirectory: string;
  readonly mode: "new" | "existing";
  readonly projectName: string;
  readonly template?: DadsProjectTemplate;
  readonly dryRun?: boolean;
};

export type DadsProjectInitialization = {
  readonly projectRoot: string;
  readonly created: readonly string[];
  readonly unchanged: readonly string[];
};

export function initializeDadsProject(
  options: InitializeDadsProjectOptions,
): DadsProjectInitialization {
  const projectRoot = resolveProjectRoot(options);
  const files = renderStarterProjectFiles({
    projectName: options.projectName,
    ...(options.template === undefined ? {} : { template: options.template }),
  });
  assertRecognizedProjectRoot(projectRoot);
  const agentSkillSynchronization =
    inspectAgentSkillSynchronization(projectRoot);

  const { created, unchanged } = classifyStarterFiles(projectRoot, files);
  recordAgentSkillPaths(agentSkillSynchronization, created, unchanged);
  if (!options.dryRun) writeStarterFiles(projectRoot, files, created);

  return { projectRoot, created, unchanged };
}

/**
 * Splits the rendered starter files into the ones this project is missing and
 * the ones it already holds byte for byte. There is no third case: a file that
 * exists with different content is a conflict Dads refuses to resolve.
 */
function classifyStarterFiles(
  projectRoot: string,
  files: readonly StarterProjectFile[],
): { readonly created: string[]; readonly unchanged: string[] } {
  const created: string[] = [];
  const unchanged: string[] = [];
  for (const file of files) {
    const absolutePath = join(projectRoot, file.path);
    if (!existsSync(absolutePath)) {
      created.push(file.path);
      continue;
    }
    if (readFileSync(absolutePath, "utf8") === file.content) {
      unchanged.push(file.path);
      continue;
    }
    throw new Error(`Refusing to overwrite conflicting file ${file.path}.`);
  }
  return { created, unchanged };
}

/** Reports each harness skills link beside the files, under the same wording. */
function recordAgentSkillPaths(
  agentSkillSynchronization: readonly SkillSynchronizationInspection[],
  created: string[],
  unchanged: string[],
): void {
  for (const synchronization of agentSkillSynchronization) {
    const projectPath = `${synchronization.harness}/skills`;
    if (synchronization.status === "missing") created.push(projectPath);
    else unchanged.push(projectPath);
  }
}

function writeStarterFiles(
  projectRoot: string,
  files: readonly StarterProjectFile[],
  created: readonly string[],
): void {
  for (const file of files.filter((candidate) =>
    created.includes(candidate.path),
  )) {
    const absolutePath = join(projectRoot, file.path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, file.content, {
      flag: "wx",
      mode: file.executable ? 0o755 : 0o644,
    });
  }
  synchronizeAgentSkills(projectRoot);
}

export function deriveDadsProjectName(
  targetDirectory: string,
  mode: "new" | "existing",
): string {
  const directoryName = basename(resolve(targetDirectory));
  const candidate =
    mode === "existing" ? `${directoryName}-dads` : directoryName;
  const normalized = candidate
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  if (normalized.length === 0) {
    throw new Error("Unable to derive a Dads project name.");
  }
  return normalized;
}

function resolveProjectRoot(options: InitializeDadsProjectOptions): string {
  const targetDirectory = resolve(options.targetDirectory);
  return options.mode === "existing"
    ? join(targetDirectory, "dads")
    : targetDirectory;
}

function assertRecognizedProjectRoot(projectRoot: string): void {
  if (!existsSync(projectRoot)) return;
  const entries = readdirSync(projectRoot);
  if (
    entries.length > 0 &&
    !existsSync(join(projectRoot, "dads.project.json"))
  ) {
    throw new Error(
      `Refusing to initialize non-empty directory ${projectRoot}. Use existing-project mode to add an isolated Dads project.`,
    );
  }
}
