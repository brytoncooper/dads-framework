/**
 * Turning one Nx target into a standalone Dads task, or refusing to.
 *
 * A converted task must run without Nx, without a shell, and without anything
 * left to resolve at execution time, so the default answer here is "no" and
 * every "no" is recorded with the reason a reader would need to fix it. Only a
 * fully materialized `nx:run-commands` recipe survives: placeholders are
 * substituted, the command is split into argv this package understands, and a
 * command that would smuggle Nx back in at runtime is refused outright.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DadsTestingTask,
  DroppedField,
  ImportedTaskAudit,
  NxProject,
  NxTarget,
  PlaceholderSubstitution,
  TargetConversion,
  TargetExclusion,
} from "./import-nx-types.js";
import { normalizeRoot } from "./nx-workspace-reader.js";

/** The one Nx executor whose targets can become standalone Dads tasks. */
const standaloneExecutor = "nx:run-commands";

/** Vite and Vitest reach for Nx path resolution; Dads cannot supply it. */
const nxPathSemanticsReason: TargetExclusion = {
  classification: "native-adapter-needed",
  reason:
    "Vite/Vitest config imports nxViteTsPaths and requires Nx path semantics",
};

/** Everything a converted task needs, once nothing is left to resolve. */
type StandaloneRecipe = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly substitutions: readonly PlaceholderSubstitution[];
};

/** Converts one target, or audits exactly why it was left behind. */
export async function convertTarget(input: {
  readonly workspaceRoot: string;
  readonly project: NxProject;
  readonly target: NxTarget;
  readonly sourceLocation: string;
}): Promise<TargetConversion> {
  const { project, target } = input;
  const droppedFields = target.droppedFields.map((field) => ({
    project: project.name,
    target: target.name,
    field,
  }));
  const base: Omit<
    ImportedTaskAudit,
    "classification" | "reason" | "executor"
  > = {
    project: project.name,
    target: target.name,
    sourceLocation: input.sourceLocation,
    substitutions: [],
    droppedFields: target.droppedFields,
  };
  const unsupported = unsupportedTargetReason(target);
  if (unsupported) return excluded(base, unsupported, target, droppedFields);
  const recipe = resolveStandaloneRecipe(target, project.root);
  if (recipe instanceof Error) {
    const opaque: TargetExclusion = {
      classification: "opaque",
      reason: recipe.message,
    };
    return excluded(base, opaque, target, droppedFields);
  }
  if (await hasNxViteTsPaths(input.workspaceRoot, recipe.argv, recipe.cwd)) {
    return excluded(base, nxPathSemanticsReason, target, droppedFields);
  }
  return {
    task: convertedTask(project, target, recipe),
    audit: {
      ...base,
      substitutions: recipe.substitutions,
      classification: "converted",
      reason: "fully resolved nx:run-commands recipe",
      ...(target.executor === undefined ? {} : { executor: target.executor }),
    },
    droppedFields,
  };
}

// --- Why a target cannot become a task -----------------------------------

/** The first reason this target is not importable, if there is one. */
function unsupportedTargetReason(
  target: NxTarget,
): TargetExclusion | undefined {
  if (target.continuous)
    return {
      classification: "excluded",
      reason:
        "continuous targets cannot be represented as finite standalone tasks",
    };
  if (target.inferred)
    return {
      classification: "native-adapter-needed",
      reason:
        "Nx inferred target needs a native adapter rather than an imported recipe",
    };
  if (target.executor !== standaloneExecutor)
    return foreignExecutorReason(target.executor);
  if (target.unresolvedExecutionFields.length > 0)
    return {
      classification: "opaque",
      reason: `target contains execution-affecting Nx fields that cannot be safely materialized: ${target.unresolvedExecutionFields.join(", ")}`,
    };
  return undefined;
}

/** An Nx-owned executor needs an adapter; anything else is simply opaque. */
function foreignExecutorReason(executor: string | undefined): TargetExclusion {
  if (!executor)
    return {
      classification: "opaque",
      reason: "target has no resolved executor",
    };
  return {
    classification: executor.startsWith("@nx/")
      ? "native-adapter-needed"
      : "opaque",
    reason: `executor ${executor} is not a standalone recipe`,
  };
}

/** The audited outcome for a target that produced no task. */
function excluded(
  base: Omit<ImportedTaskAudit, "classification" | "reason" | "executor">,
  exclusion: TargetExclusion,
  target: NxTarget,
  droppedFields: readonly DroppedField[],
): TargetConversion {
  return {
    audit: {
      ...base,
      classification: exclusion.classification,
      reason: exclusion.reason,
      ...(target.executor === undefined ? {} : { executor: target.executor }),
    },
    droppedFields,
  };
}

// --- Materializing the recipe --------------------------------------------

/** The argv, working directory, and substitutions a task would run with. */
function resolveStandaloneRecipe(
  target: NxTarget,
  projectRoot: string,
): StandaloneRecipe | Error {
  if (target.command === undefined)
    return new Error("nx:run-commands target has no single resolved command");
  const command = resolveTemplate(target.command, projectRoot);
  if (command instanceof Error) return command;
  const cwd = resolveCwd(target.cwd, projectRoot);
  if (cwd instanceof Error) return cwd;
  const argv = parseStandaloneArgv(command.value);
  if (argv instanceof Error) return argv;
  return {
    argv,
    cwd: cwd.value,
    substitutions: [...command.substitutions, ...cwd.substitutions],
  };
}

/** The Dads task a resolved recipe becomes. */
function convertedTask(
  project: NxProject,
  target: NxTarget,
  recipe: StandaloneRecipe,
): DadsTestingTask {
  return {
    id: `${project.id}:${target.id}`,
    project: project.id,
    kind: taskKind(target.name),
    execution: {
      executable: recipe.argv[0] ?? "",
      ...(recipe.argv.length > 1 ? { args: recipe.argv.slice(1) } : {}),
      cwd: recipe.cwd,
    },
    dependsOn: [],
    impact: { mode: "project" },
  };
}

/** What a target's name says the task is for; `nx-native-model.ts` has `nativeTaskKind` for an anchored reading. */
function taskKind(target: string): DadsTestingTask["kind"] {
  const normalized = target.toLowerCase();
  if (normalized.includes("typecheck") || normalized.includes("type-check"))
    return "typecheck";
  if (normalized.includes("lint")) return "lint";
  if (normalized.includes("build")) return "build";
  if (normalized.includes("test") || normalized.includes("spec")) return "test";
  return "custom";
}

// --- Placeholders --------------------------------------------------------

/** Substitutes the placeholders Dads owns, and refuses any that remain. */
function resolveTemplate(
  value: string,
  projectRoot: string,
):
  | {
      readonly value: string;
      readonly substitutions: readonly PlaceholderSubstitution[];
    }
  | Error {
  const replacements: readonly {
    readonly placeholder: PlaceholderSubstitution["placeholder"];
    readonly replacement: string;
  }[] = [
    { placeholder: "{workspaceRoot}", replacement: "." },
    { placeholder: "{projectRoot}", replacement: projectRoot },
  ];
  const substitutions: PlaceholderSubstitution[] = [];
  let resolved = value;
  for (const entry of replacements) {
    if (!resolved.includes(entry.placeholder)) continue;
    const replacement = normalizeRoot(entry.replacement);
    substitutions.push({ placeholder: entry.placeholder, value: replacement });
    resolved = resolved.split(entry.placeholder).join(replacement);
  }
  if (/[{][^}]+[}]/.test(resolved))
    return new Error("command contains unresolved Nx placeholders");
  return { value: resolved, substitutions };
}

/** A working directory that stays inside the source workspace, or a refusal. */
function resolveCwd(
  value: string | undefined,
  projectRoot: string,
):
  | {
      readonly value: string;
      readonly substitutions: readonly PlaceholderSubstitution[];
    }
  | Error {
  const source = value ?? "{workspaceRoot}";
  const resolved = resolveTemplate(source, projectRoot);
  if (resolved instanceof Error) return resolved;
  if (path.isAbsolute(resolved.value))
    return new Error(
      "cwd must be workspace-relative after placeholder resolution",
    );
  const normalized = normalizeRoot(resolved.value);
  if (normalized === ".." || normalized.startsWith("../"))
    return new Error("cwd escapes the source workspace");
  return { value: normalized, substitutions: resolved.substitutions };
}

// --- Argv ----------------------------------------------------------------

/** Where one argument ends and the next begins, outside of quotes. */
const argumentBoundary = /\s/;
/** Syntax only a shell can interpret, which a standalone task has none of. */
const shellControlSyntax = /[|&;`$<>\n\r]/;

/** How far the scanner has got through one command string. */
type ArgvScan = {
  readonly argv: readonly string[];
  readonly current: string;
  readonly quote: "'" | '"' | undefined;
};

/** Splits a resolved command into argv, or refuses it with the reason. */
function parseStandaloneArgv(command: string): readonly string[] | Error {
  if (shellControlSyntax.test(command))
    return new Error(
      "command uses shell control syntax and cannot become standalone argv",
    );
  const argv = splitArgv(command);
  if (argv instanceof Error) return argv;
  if (argv.length === 0) return new Error("command is empty");
  if (argv.some(invokesNx))
    return new Error(
      "command invokes Nx and would retain a hidden Nx runtime dependency",
    );
  return argv;
}

/** Scans the whole command, one character at a time. */
function splitArgv(command: string): readonly string[] | Error {
  let scan: ArgvScan = { argv: [], current: "", quote: undefined };
  for (const character of command) {
    const next = scanCharacter(scan, character);
    if (next instanceof Error) return next;
    scan = next;
  }
  if (scan.quote !== undefined)
    return new Error("command contains an unclosed quote");
  return endArgument(scan).argv;
}

/** The scan after one more character, or a refusal that ends it. */
function scanCharacter(scan: ArgvScan, character: string): ArgvScan | Error {
  if (scan.quote !== undefined) return scanQuoted(scan, character);
  if (character === "'" || character === '"')
    return { ...scan, quote: character };
  if (argumentBoundary.test(character)) return endArgument(scan);
  if (character === "\\")
    return new Error(
      "command uses shell escapes and cannot become standalone argv",
    );
  return { ...scan, current: scan.current + character };
}

/** Inside a quote every character is literal until the quote closes. */
function scanQuoted(scan: ArgvScan, character: string): ArgvScan {
  if (character === scan.quote) return { ...scan, quote: undefined };
  return { ...scan, current: scan.current + character };
}

/** Ends the argument being built, if there is one. */
function endArgument(scan: ArgvScan): ArgvScan {
  if (scan.current === "") return scan;
  return { argv: [...scan.argv, scan.current], current: "", quote: scan.quote };
}

/** True for an argument that would put Nx back on the execution path. */
function invokesNx(argument: string): boolean {
  return (
    argument === "nx" ||
    argument.startsWith("@nx/") ||
    /(?:^|\/)node_modules\/nx(?:\/|$)/.test(argument) ||
    argument.endsWith("/nx")
  );
}

// --- Vite and Vitest -----------------------------------------------------

/**
 * True when a Vite or Vitest command would depend on Nx path semantics. The
 * config is read rather than trusted: a config this importer cannot reach is
 * treated as risky, because being wrong here means shipping a task that fails
 * only outside Nx.
 */
async function hasNxViteTsPaths(
  workspaceRoot: string,
  argv: readonly string[],
  cwd: string,
): Promise<boolean> {
  if (!argv.some((argument) => /(^|\/)(vite|vitest)$/.test(argument)))
    return false;
  const configured = configuredVitePath(argv);
  if (!configured) return false;
  if (path.isAbsolute(configured) || configured.includes("..")) return true;
  try {
    const config = await fs.readFile(
      path.join(workspaceRoot, cwd, configured),
      "utf8",
    );
    return /nxViteTsPaths/.test(config);
  } catch {
    return true;
  }
}

/** The `--config` value a Vite or Vitest command names, in either spelling. */
function configuredVitePath(argv: readonly string[]): string | undefined {
  const inlineConfig = argv.find((argument) =>
    argument.startsWith("--config="),
  );
  if (inlineConfig) return inlineConfig.slice("--config=".length);
  const configIndex = argv.findIndex((argument) => argument === "--config");
  return configIndex >= 0 ? argv[configIndex + 1] : undefined;
}
