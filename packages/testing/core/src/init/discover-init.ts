import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { resolveNativeTestingBinary } from "../native-platform.js";
import { expandTestingManifest } from "../testing-api.js";
import { defaultTestingManifestFileName } from "../testing-manifest.js";
import { writeFilesAtomically } from "../write-files-atomically.js";
import { describeError } from "./describe-error.js";
import {
  detectRootVitestConfig,
  detectSqlMigrationRoots,
  detectWorkspacePureFactories,
  workspaceUsesVitest,
  type RootVitestConfig,
} from "./detect-pure-factories.js";
import { scanWorkspaceLayout, type WorkspaceLayout } from "./discover-layout.js";
import { compareText } from "./infer-one-package.js";
import { workspaceRelative } from "./workspace-relative-path.js";

/**
 * Generates a compact, declarative `dads.testing.json` using `workspace.discover`
 * for npm, pnpm, yarn, and Nx (`project.json`) workspaces. The generated manifest
 * is validated by the native engine (`expand-manifest`) when installed and written
 * atomically via `writeFilesAtomically`.
 */

export type DiscoverInitOptions = {
  readonly workspaceRoot: string;
  readonly manifestPath?: string;
  readonly force?: boolean;
  /** An explicit native binary is intended for local development and test harnesses. */
  readonly nativeBinary?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Overrides how the native engine is found; undefined means "not installed". */
  readonly resolveNativeBinary?: () => string | undefined;
};

export type DiscoverTargetTemplate = {
  readonly target: string;
  readonly kind: "test" | "typecheck" | "lint" | "build" | "custom";
  readonly when: { readonly hasTarget: string };
  readonly execution: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly fileNarrowing?: {
      readonly suffixes: readonly string[];
      readonly setupFiles?: readonly string[];
    };
  };
  readonly autoVitestNarrowing?: boolean;
  readonly autoJestNarrowing?: boolean;
  readonly impact: {
    readonly mode: "reachability" | "changed-files" | "project" | "always";
    readonly paths: readonly string[];
  };
};

export type DiscoverManifestDocument = {
  readonly schemaVersion: 1;
  readonly workspace: {
    readonly root: ".";
    readonly ignorePaths?: readonly string[];
    readonly pureFactories?: readonly string[];
    readonly sql?: { readonly migrationRoots: readonly string[] };
    readonly discover: {
      readonly projectFiles: readonly string[];
      readonly excludeRoots?: readonly string[];
      readonly targetTemplates: readonly DiscoverTargetTemplate[];
    };
  };
};

export type DiscoverInitValidation = {
  readonly method: "native" | "structural";
  readonly ok: true;
  readonly projectCount: number;
  readonly taskCount: number;
};

export type DiscoverInitResult = {
  readonly manifestPath: string;
  readonly manifest: DiscoverManifestDocument;
  readonly pureFactories: readonly string[];
  readonly ignorePaths: readonly string[];
  readonly setupFiles: readonly string[];
  readonly sqlMigrationRoots: readonly string[];
  readonly validation: DiscoverInitValidation;
  readonly nextStep: string;
};

type TargetSpec = {
  readonly target: string;
  readonly kind: "test" | "typecheck" | "lint" | "build";
  readonly impactMode: "reachability" | "project";
};

const recognizedTargets: readonly TargetSpec[] = [
  { target: "test", kind: "test", impactMode: "reachability" },
  { target: "test:unit", kind: "test", impactMode: "reachability" },
  { target: "test:lib", kind: "test", impactMode: "reachability" },
  { target: "test:integration", kind: "test", impactMode: "reachability" },
  { target: "typecheck", kind: "typecheck", impactMode: "reachability" },
  { target: "test:types", kind: "typecheck", impactMode: "reachability" },
  { target: "type-check", kind: "typecheck", impactMode: "reachability" },
  { target: "check-types", kind: "typecheck", impactMode: "reachability" },
  { target: "lint", kind: "lint", impactMode: "project" },
  { target: "build", kind: "build", impactMode: "project" },
];

const defaultVitestSuffixes: readonly string[] = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"];

const nextStepGuidance = "Run npx dad-test audit --fix to discover dynamic file reads.";

export async function initDiscoverManifest(options: DiscoverInitOptions): Promise<DiscoverInitResult> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const { manifestFile, manifestPath } = resolveManifestDestination(workspaceRoot, options.manifestPath);
  if (existsSync(manifestFile) && options.force !== true) {
    throw new Error(`Refusing to overwrite existing ${manifestPath}; pass --force to replace it.`);
  }

  const detected = detectWorkspaceFeatures(workspaceRoot);
  const manifest = buildDiscoverManifestDocument(detected);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const nativeBinary = (options.resolveNativeBinary ?? resolveInstalledNativeBinary(options))();
  const validation = await validateDiscoverManifest({
    workspaceRoot,
    manifestFile,
    manifestText,
    nativeBinary,
    layout: detected.layout,
    templates: detected.templates,
  });
  writeFilesAtomically([{ path: manifestFile, contents: manifestText }]);

  return {
    manifestPath,
    manifest,
    pureFactories: detected.pureFactories,
    ignorePaths: detected.ignorePaths,
    setupFiles: detected.rootVitest.setupFiles,
    sqlMigrationRoots: detected.sqlMigrationRoots,
    validation,
    nextStep: nextStepGuidance,
  };
}

type DetectedDiscoverFeatures = {
  readonly layout: WorkspaceLayout;
  readonly pureFactories: readonly string[];
  readonly rootVitest: RootVitestConfig;
  readonly sqlMigrationRoots: readonly string[];
  readonly ignorePaths: readonly string[];
  readonly templates: readonly DiscoverTargetTemplate[];
};

function detectWorkspaceFeatures(workspaceRoot: string): DetectedDiscoverFeatures {
  const layout = scanWorkspaceLayout(workspaceRoot);
  const projectDirs = layout.projects.map((project) => project.root);
  const pureFactories = detectWorkspacePureFactories(workspaceRoot, projectDirs);
  const rootVitest = detectRootVitestConfig(workspaceRoot);
  const usesVitest = workspaceUsesVitest(workspaceRoot, projectDirs);
  const usesJest = workspaceUsesJest(workspaceRoot, projectDirs);
  const sqlMigrationRoots = detectSqlMigrationRoots(workspaceRoot);
  const ignorePaths = buildSafeIgnorePaths(projectDirs);
  const templates = buildTargetTemplates(layout, usesVitest, usesJest, rootVitest);
  if (templates.length === 0) {
    throw new Error(
      "No recognized test, test:integration, typecheck, lint, or build targets were found; no manifest was written.",
    );
  }
  return { layout, pureFactories, rootVitest, sqlMigrationRoots, ignorePaths, templates };
}

function resolveManifestDestination(
  workspaceRoot: string,
  requestedPath: string | undefined,
): { readonly manifestFile: string; readonly manifestPath: string } {
  const target = requestedPath ?? defaultTestingManifestFileName;
  const manifestFile = resolve(workspaceRoot, target);
  if (manifestFile !== workspaceRoot && !manifestFile.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error(`The manifest path must stay inside the workspace: ${target}`);
  }
  return { manifestFile, manifestPath: workspaceRelative(workspaceRoot, manifestFile) };
}

function buildDiscoverManifestDocument(detected: DetectedDiscoverFeatures): DiscoverManifestDocument {
  return {
    schemaVersion: 1,
    workspace: {
      root: ".",
      ...(detected.ignorePaths.length === 0 ? {} : { ignorePaths: detected.ignorePaths }),
      ...(detected.pureFactories.length === 0 ? {} : { pureFactories: detected.pureFactories }),
      ...(detected.sqlMigrationRoots.length === 0 ? {} : { sql: { migrationRoots: detected.sqlMigrationRoots } }),
      discover: {
        projectFiles: detected.layout.projectFiles,
        ...(detected.layout.excludeRoots.length === 0 ? {} : { excludeRoots: detected.layout.excludeRoots }),
        targetTemplates: detected.templates,
      },
    },
  };
}

function buildSafeIgnorePaths(projectDirs: readonly string[]): readonly string[] {
  const ignores: string[] = [];
  const hasDocsProject = projectDirs.some((dir) => dir === "docs" || dir.startsWith("docs/"));
  if (!hasDocsProject) ignores.push("docs/**");
  ignores.push(".github/**", ".agents/**", ".claude/**", ".cursor/**", "**/*.md", "**/*.mdx");
  return ignores;
}

function buildTargetTemplates(
  layout: WorkspaceLayout,
  usesVitest: boolean,
  usesJest: boolean,
  rootVitest: RootVitestConfig,
): readonly DiscoverTargetTemplate[] {
  const declaredTargets = new Set<string>();
  for (const project of layout.projects) {
    for (const target of project.targets) declaredTargets.add(target);
  }
  const templates: DiscoverTargetTemplate[] = [];
  for (const spec of recognizedTargets) {
    if (!declaredTargets.has(spec.target)) continue;
    templates.push(createTemplateForTarget(spec, layout, usesVitest, usesJest, rootVitest));
  }
  return templates;
}

function createTemplateForTarget(
  spec: TargetSpec,
  layout: WorkspaceLayout,
  usesVitest: boolean,
  usesJest: boolean,
  rootVitest: RootVitestConfig,
): DiscoverTargetTemplate {
  if (spec.target === "test" && layout.kind === "package-json") {
    if (usesVitest) return buildVitestTestTemplate(rootVitest);
    if (usesJest) return buildJestTestTemplate();
  }
  const execution =
    layout.kind === "nx-project-json"
      ? { executable: "npx", args: ["nx", "run", `{project}:${spec.target}`] }
      : { executable: layout.packageManager, args: ["run", spec.target], cwd: "{projectRoot}" };
  const impactPaths = spec.kind === "test" ? collectRootVitestImpactPaths(rootVitest) : [];
  return {
    target: spec.target,
    kind: spec.kind,
    when: { hasTarget: spec.target },
    execution,
    ...autoNarrowingFlags(spec.target, usesVitest, usesJest, rootVitest),
    impact: { mode: spec.impactMode, paths: impactPaths },
  };
}

function autoNarrowingFlags(
  target: string,
  usesVitest: boolean,
  usesJest: boolean,
  rootVitest: RootVitestConfig,
): { readonly autoVitestNarrowing?: boolean; readonly autoJestNarrowing?: boolean } {
  if (target !== "test") return {};
  return {
    ...(usesVitest && !rootVitest.dynamicSetupFiles ? { autoVitestNarrowing: true } : {}),
    ...(usesJest ? { autoJestNarrowing: true } : {}),
  };
}

function buildJestTestTemplate(): DiscoverTargetTemplate {
  return {
    target: "test",
    kind: "test",
    when: { hasTarget: "test" },
    execution: { executable: "npx", args: ["jest", "--runTestsByPath"], cwd: "{projectRoot}" },
    autoJestNarrowing: true,
    impact: { mode: "reachability", paths: [] },
  };
}

function workspaceUsesJest(workspaceRoot: string, projectDirs: readonly string[]): boolean {
  const jestConfigs = [
    "jest.config.ts",
    "jest.config.mts",
    "jest.config.cts",
    "jest.config.js",
    "jest.config.mjs",
    "jest.config.cjs",
    "jest.config.json",
  ];
  for (const dir of [".", ...projectDirs]) {
    const base = dir === "." ? workspaceRoot : join(workspaceRoot, dir);
    if (jestConfigs.some((name) => existsSync(join(base, name)))) return true;
  }
  try {
    const raw = readFileSync(join(workspaceRoot, "package.json"), "utf8");
    return /"(?:jest|@nx\/jest)"\s*:/u.test(raw);
  } catch {
    return false;
  }
}

function buildVitestTestTemplate(rootVitest: RootVitestConfig): DiscoverTargetTemplate {
  const hasStaticSetup = !rootVitest.dynamicSetupFiles && rootVitest.setupFiles.length > 0;
  return {
    target: "test",
    kind: "test",
    when: { hasTarget: "test" },
    execution: {
      executable: "npx",
      args: ["vitest", "run"],
      cwd: "{projectRoot}",
      ...(hasStaticSetup
        ? { fileNarrowing: { suffixes: defaultVitestSuffixes, setupFiles: rootVitest.setupFiles } }
        : {}),
    },
    ...(rootVitest.dynamicSetupFiles ? {} : { autoVitestNarrowing: true }),
    impact: { mode: "reachability", paths: collectRootVitestImpactPaths(rootVitest) },
  };
}

function collectRootVitestImpactPaths(rootVitest: RootVitestConfig): readonly string[] {
  const paths = new Set<string>();
  if (rootVitest.configPath !== undefined) paths.add(rootVitest.configPath);
  for (const setupFile of rootVitest.setupFiles) paths.add(setupFile);
  return [...paths].sort(compareText);
}

async function validateDiscoverManifest(request: {
  readonly workspaceRoot: string;
  readonly manifestFile: string;
  readonly manifestText: string;
  readonly nativeBinary: string | undefined;
  readonly layout: WorkspaceLayout;
  readonly templates: readonly DiscoverTargetTemplate[];
}): Promise<DiscoverInitValidation> {
  if (request.nativeBinary === undefined) {
    return structuralCounts(request.layout, request.templates);
  }
  const tempFile = `${request.manifestFile}.${randomUUID()}.tmp`;
  writeFileSync(tempFile, request.manifestText, "utf8");
  try {
    const expanded = await expandTestingManifest({
      workspaceRoot: request.workspaceRoot,
      manifestPath: workspaceRelative(request.workspaceRoot, tempFile),
      nativeBinary: request.nativeBinary,
    });
    return {
      method: "native",
      ok: true,
      projectCount: expanded.projects.length,
      taskCount: expanded.tasks.length,
    };
  } catch (error: unknown) {
    throw new Error(`Generated discover manifest was rejected by dad-test: ${describeError(error)}`, {
      cause: error,
    });
  } finally {
    rmSync(tempFile, { force: true });
  }
}

function structuralCounts(
  layout: WorkspaceLayout,
  templates: readonly DiscoverTargetTemplate[],
): DiscoverInitValidation {
  let taskCount = 0;
  for (const project of layout.projects) {
    for (const template of templates) {
      if (project.targets.has(template.when.hasTarget)) taskCount += 1;
    }
  }
  return {
    method: "structural",
    ok: true,
    projectCount: layout.projects.length,
    taskCount,
  };
}

function resolveInstalledNativeBinary(options: DiscoverInitOptions): () => string | undefined {
  return () => {
    try {
      return resolveNativeTestingBinary({
        ...(options.nativeBinary === undefined ? {} : { explicitBinary: options.nativeBinary }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      }).binary;
    } catch {
      return undefined;
    }
  };
}
