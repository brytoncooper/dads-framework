/**
 * Every shape the Nx importer reads, produces, or hands back.
 *
 * Two vocabularies meet here and are deliberately kept apart. `Nx*` types
 * describe what was read out of an Nx workspace and are internal; `Dads*`
 * types and the report describe what this package publishes and are the
 * contract consumers depend on. Nothing in this file behaves, so a reader who
 * wants to know what an import produces can read one file and stop.
 */
import type { JsonValue } from "./json-values.js";

// --- Public contract -----------------------------------------------------

export type NxCommandRunner = (input: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export type ImportNxTestingOptions = {
  readonly workspaceRoot: string;
  /** Full immutable Git object ID the caller approved for this import. */
  readonly expectedGitSha: string;
  readonly runner?: NxCommandRunner;
};

export type DadsTestingTask = {
  readonly id: string;
  readonly project: string;
  readonly kind: "test" | "typecheck" | "lint" | "build" | "custom";
  readonly execution: {
    readonly executable: string;
    readonly args?: readonly string[];
    readonly cwd: string;
  };
  readonly dependsOn: readonly string[];
  readonly impact: {
    readonly mode: "project";
  };
};

export type DadsTestingManifest = {
  readonly schemaVersion: 1;
  readonly workspace: {
    readonly root: ".";
    readonly fullFallback: { readonly taskIds: readonly string[] };
  };
  readonly projects: readonly {
    readonly id: string;
    readonly root: string;
    readonly fallbackDependencies: readonly string[];
  }[];
  readonly tasks: readonly DadsTestingTask[];
};

export type NxImportReport = {
  readonly schemaVersion: 1;
  readonly importer: {
    readonly name: "@dads-framework/testing-import-nx";
    readonly manifestChecksum: string | null;
  };
  readonly source: {
    readonly workspaceRoot: string;
    readonly expectedGitSha: string;
    readonly resolvedGitSha: string;
    readonly versions: Readonly<Record<string, string>>;
    readonly inputs: readonly {
      readonly path: string;
      readonly sha256: string;
    }[];
    readonly locations: readonly string[];
  };
  readonly nx: {
    readonly projects: readonly string[];
    readonly resolvedProjects: readonly {
      readonly name: string;
      readonly configuration: JsonValue;
    }[];
    readonly projectGraph: JsonValue;
    readonly executors: readonly string[];
    readonly plugins: readonly string[];
  };
  readonly summary: {
    readonly projects: number;
    readonly targets: number;
    readonly converted: number;
    readonly excluded: number;
  };
  readonly tasks: readonly ImportedTaskAudit[];
  readonly droppedFields: readonly DroppedField[];
  readonly failures: readonly ImportFailure[];
};

export type ImportNxTestingResult = {
  readonly manifest: DadsTestingManifest;
  readonly report: NxImportReport;
  readonly manifestPath: string;
  readonly reportPath: string;
};

// --- Audit trail ---------------------------------------------------------

export type ImportedTaskAudit = {
  readonly project: string;
  readonly target: string;
  readonly sourceLocation: string;
  readonly classification:
    "converted" | "native-adapter-needed" | "opaque" | "excluded";
  readonly reason: string;
  readonly executor?: string;
  readonly substitutions: readonly PlaceholderSubstitution[];
  readonly droppedFields: readonly string[];
};

export type PlaceholderSubstitution = {
  readonly placeholder: "{workspaceRoot}" | "{projectRoot}";
  readonly value: string;
};

export type DroppedField = {
  readonly project: string;
  readonly target: string;
  readonly field: string;
};

export type ImportFailure = {
  readonly stage: "nx-command" | "json" | "graph" | "project" | "conversion";
  readonly subject: string;
  readonly message: string;
};

/** Why one Nx target did not become a standalone task. */
export type TargetExclusion = {
  readonly classification: ImportedTaskAudit["classification"];
  readonly reason: string;
};

/** What converting one Nx target contributed to the import. */
export type TargetConversion = {
  readonly task?: DadsTestingTask;
  readonly audit: ImportedTaskAudit;
  readonly droppedFields: readonly DroppedField[];
  readonly failure?: ImportFailure;
};

// --- What was read out of the Nx workspace -------------------------------

export type NxProject = {
  readonly name: string;
  readonly id: string;
  readonly root: string;
  readonly targets: readonly NxTarget[];
};

export type NxTarget = {
  readonly name: string;
  readonly id: string;
  readonly executor?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly continuous: boolean;
  readonly inferred: boolean;
  readonly unresolvedExecutionFields: readonly string[];
  readonly droppedFields: readonly string[];
};

/** One project's configuration exactly as `nx show project` returned it. */
export type NxProjectSnapshot = {
  readonly name: string;
  readonly value: JsonValue;
};

/** The Git object ID the caller approved, and the one HEAD actually holds. */
export type GitSnapshot = {
  readonly expected: string;
  readonly resolved: string;
};

/** One file whose content the import was taken over. */
export type DigestedInput = {
  readonly path: string;
  readonly sha256: string;
};
