import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describeError } from "../init/describe-error.js";
import { detectWorkspacePureFactories, normalizeSafeRelativePath } from "../init/detect-pure-factories.js";
import { compareText } from "../init/infer-one-package.js";
import { workspaceRelative } from "../init/workspace-relative-path.js";
import { isRecord, isUnknownArray, readStringList } from "../parse-guards.js";
import {
  expandTestingManifest,
  planTesting,
  type TestingDiagnoseResult,
  type TestingFallbackTrap,
  type TestingWideningCulprit,
} from "../testing-api.js";
import { defaultTestingManifestFileName } from "../testing-manifest.js";
import { writeFilesAtomically } from "../write-files-atomically.js";

/**
 * Applies safe, deterministic remediations from `dad-test diagnose` directly to
 * `dads.testing.json`, validating the patched candidate with `dad-test plan`
 * before writing atomically.
 */

export type DiagnoseFixField = "workspace.ignorePaths" | "workspace.pureFactories" | "workspace.dynamicImportScopes";

export type DiagnoseFixChange = {
  readonly field: DiagnoseFixField;
  readonly summary: string;
  readonly reason: string;
};

export type DiagnoseFixResult = {
  readonly manifestPath: string;
  readonly dryRun: boolean;
  readonly applied: boolean;
  readonly validated: boolean;
  readonly changes: readonly DiagnoseFixChange[];
};

export type ApplyDiagnoseFixesOptions = {
  readonly workspaceRoot: string;
  readonly manifestPath?: string;
  readonly diagnosis: TestingDiagnoseResult;
  readonly dryRun: boolean;
  readonly nativeBinary?: string;
};

type DynamicScopeAddition = {
  readonly loaderPath: string;
  readonly project: string;
  readonly projectRoot: string;
  readonly code: string;
};

type FixPatchPlan = {
  readonly ignoreAdditions: readonly string[];
  readonly pureAdditions: readonly string[];
  readonly scopeAdditions: readonly DynamicScopeAddition[];
};

const dynamicImportCodes = new Set(["nonliteral-dynamic-import", "nonliteral-commonjs-require"]);
const safeDirPrefixes: readonly string[] = ["docs", ".github", ".vscode"];
const safeFileMatchers: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  { pattern: /^README\.md$/u, replacement: "README.md" },
  { pattern: /^(?:\*\*\/)?\*\.md$/u, replacement: "**/*.md" },
  { pattern: /^LICENSE(\*|\.[^/]+)?$/iu, replacement: "LICENSE*" },
  { pattern: /^CHANGELOG(\*|\.[^/]+)?$/iu, replacement: "CHANGELOG*" },
];

/** Verifies that `--fix` targets a real on-disk manifest inside the workspace. */
export function resolveFixableManifestPath(
  workspaceRoot: string,
  manifestPath: string | undefined,
): { readonly manifestFile: string; readonly manifestPath: string } {
  const root = resolve(workspaceRoot);
  const requested = manifestPath ?? defaultTestingManifestFileName;
  const manifestFile = resolve(root, requested);
  if (manifestFile !== root && !manifestFile.startsWith(`${root}${sep}`)) {
    throw new Error(`The manifest path must stay inside the workspace: ${requested}`);
  }
  if (!existsSync(manifestFile)) {
    const nxHint = manifestPath === undefined && existsSync(join(root, "nx.json"));
    throw new Error(
      nxHint
        ? `diagnose --fix requires a ${defaultTestingManifestFileName} manifest (cannot auto-patch in manifest-less Nx mode). Run 'dad-test init --discover' to create one, or pass --manifest <path>.`
        : `diagnose --fix requires an existing ${requested} manifest. Run 'dad-test init --discover' or pass --manifest <path>.`,
    );
  }
  return { manifestFile, manifestPath: workspaceRelative(root, manifestFile) };
}

export async function applyDiagnoseFixes(options: ApplyDiagnoseFixesOptions): Promise<DiagnoseFixResult> {
  const root = resolve(options.workspaceRoot);
  const { manifestFile, manifestPath } = resolveFixableManifestPath(root, options.manifestPath);
  const { document, workspace } = readRawManifestAndWorkspace(manifestFile, manifestPath);
  const projectRoots = await resolveProjectRoots(root, manifestPath, document, workspace, options);
  const plan: FixPatchPlan = {
    ignoreAdditions: collectSafeIgnoreAdditions(
      options.diagnosis.fallbackTraps,
      readStringList(workspace["ignorePaths"]),
    ),
    pureAdditions: collectPureFactoryAdditions(root, options.diagnosis, readStringList(workspace["pureFactories"]), [
      ...projectRoots.values(),
    ]),
    scopeAdditions: collectDynamicScopeAdditions(
      options.diagnosis,
      readScopesRecord(workspace["dynamicImportScopes"]),
      projectRoots,
    ),
  };
  const changes = buildChangeList(plan);
  if (changes.length === 0 || options.dryRun) {
    return { manifestPath, dryRun: options.dryRun, applied: false, validated: false, changes };
  }
  const patchedText = `${JSON.stringify(buildPatchedDocument(document, workspace, plan), null, 2)}\n`;
  await validateCandidateManifest(root, manifestFile, manifestPath, patchedText, options.nativeBinary);
  writeFilesAtomically([{ path: manifestFile, contents: patchedText }]);
  return { manifestPath, dryRun: false, applied: true, validated: true, changes };
}

function readRawManifestAndWorkspace(
  manifestFile: string,
  manifestPath: string,
): { readonly document: Record<string, unknown>; readonly workspace: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch (error: unknown) {
    throw new Error(`Unable to parse ${manifestPath}: ${describeError(error)}`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`${manifestPath} must be a JSON object.`);
  const workspace = parsed["workspace"];
  if (!isRecord(workspace)) throw new Error(`${manifestPath} must contain a workspace object.`);
  return { document: parsed, workspace };
}

function readScopesRecord(value: unknown): Readonly<Record<string, readonly string[]>> {
  if (!isRecord(value)) return {};
  const result: Record<string, readonly string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isUnknownArray(entry)) result[key] = readStringList(entry);
  }
  return result;
}

function collectSafeIgnoreAdditions(
  traps: readonly TestingFallbackTrap[],
  existing: readonly string[],
): readonly string[] {
  const existingSet = new Set(existing);
  const proposed = new Set<string>();
  for (const trap of traps) {
    for (const pattern of safeIgnorePatternsForTrap(trap)) {
      if (!existingSet.has(pattern)) proposed.add(pattern);
    }
  }
  return [...proposed].sort(compareText);
}

function safeIgnorePatternsForTrap(trap: TestingFallbackTrap): readonly string[] {
  if (trap.kind === "unowned" || trap.kind === "unowned-directory") {
    const direct = matchSafePathOrPrefix(trap.prefix, false);
    return direct !== undefined ? [direct] : collectSafeSamples(trap.samplePaths, trap.remediation.safety === "safe");
  }
  if (trap.kind === "non-code-in-reachability-project" && trap.remediation.safety === "safe") {
    return trap.prefix === "*.md" || trap.prefix.startsWith("*.md ")
      ? ["**/*.md"]
      : collectSafeSamples(trap.samplePaths, false);
  }
  return [];
}

function collectSafeSamples(samples: readonly string[], allowMarkdown: boolean): readonly string[] {
  const patterns = new Set<string>();
  for (const sample of samples) {
    const matched = matchSafePathOrPrefix(sample, allowMarkdown);
    if (matched !== undefined) patterns.add(matched);
  }
  return [...patterns];
}

function matchSafePathOrPrefix(raw: string, allowMarkdown: boolean): string | undefined {
  const cleaned = raw.replace(/^\.\//u, "").replace(/\/+$/u, "");
  for (const dir of safeDirPrefixes) {
    if (cleaned === dir || cleaned === `${dir}/**` || cleaned.startsWith(`${dir}/`)) return `${dir}/**`;
  }
  for (const matcher of safeFileMatchers) {
    if (matcher.pattern.test(cleaned)) return matcher.replacement;
  }
  return allowMarkdown && cleaned.toLowerCase().endsWith(".md") ? "**/*.md" : undefined;
}

function collectPureFactoryAdditions(
  workspaceRoot: string,
  diagnosis: TestingDiagnoseResult,
  existing: readonly string[],
  projectRoots: readonly string[],
): readonly string[] {
  const culprits = [...diagnosis.workspaceUncertainties, ...diagnosis.wideningCulprits];
  const hasImpure = culprits.some(
    (culprit) => /impure|side-effect|pure/iu.test(culprit.code) || /impure|pureFactories/iu.test(culprit.message),
  );
  if (existing.length > 0 && !hasImpure) return [];
  const existingSet = new Set(existing);
  return detectWorkspacePureFactories(workspaceRoot, projectRoots).filter((factory) => !existingSet.has(factory));
}

async function resolveProjectRoots(
  workspaceRoot: string,
  manifestPath: string,
  document: Readonly<Record<string, unknown>>,
  workspace: Readonly<Record<string, unknown>>,
  options: ApplyDiagnoseFixesOptions,
): Promise<ReadonlyMap<string, string>> {
  const roots = extractExplicitProjectRoots(document);
  const culprits = [...options.diagnosis.workspaceUncertainties, ...options.diagnosis.wideningCulprits];
  const needsExpand =
    workspace["discover"] !== undefined &&
    culprits.some((culprit) => dynamicImportCodes.has(culprit.code) && culprit.project !== undefined);
  if (!needsExpand) return roots;
  try {
    const expanded = await expandTestingManifest({
      workspaceRoot,
      manifestPath,
      ...(options.nativeBinary === undefined ? {} : { nativeBinary: options.nativeBinary }),
    });
    for (const project of expanded.projects) roots.set(project.id, project.root);
  } catch {
    // Keep explicit project roots when discovery expansion is unavailable.
  }
  return roots;
}

function extractExplicitProjectRoots(document: Readonly<Record<string, unknown>>): Map<string, string> {
  const roots = new Map<string, string>();
  const projects = document["projects"];
  if (!isUnknownArray(projects)) return roots;
  for (const item of projects) {
    if (!isRecord(item)) continue;
    if (typeof item["id"] === "string" && typeof item["root"] === "string") roots.set(item["id"], item["root"]);
  }
  return roots;
}

function collectDynamicScopeAdditions(
  diagnosis: TestingDiagnoseResult,
  existingScopes: Readonly<Record<string, readonly string[]>>,
  projectRoots: ReadonlyMap<string, string>,
): readonly DynamicScopeAddition[] {
  const seen = new Set<string>(Object.keys(existingScopes));
  const additions: DynamicScopeAddition[] = [];
  for (const culprit of [...diagnosis.workspaceUncertainties, ...diagnosis.wideningCulprits]) {
    const candidate = toDynamicScopeAddition(culprit, seen, projectRoots);
    if (candidate === undefined) continue;
    seen.add(candidate.loaderPath);
    additions.push(candidate);
  }
  return additions.sort((left, right) => compareText(left.loaderPath, right.loaderPath));
}

function toDynamicScopeAddition(
  culprit: TestingWideningCulprit,
  seen: ReadonlySet<string>,
  projectRoots: ReadonlyMap<string, string>,
): DynamicScopeAddition | undefined {
  if (!dynamicImportCodes.has(culprit.code) || culprit.remediation.safety !== "safe") return undefined;
  if (culprit.project === undefined || seen.has(culprit.path)) return undefined;
  const loaderPath = normalizeSafeRelativePath(culprit.path);
  const projectRoot = resolveSafeOwningRoot(culprit.project, loaderPath, projectRoots);
  if (loaderPath === undefined || projectRoot === undefined) return undefined;
  return { loaderPath, project: culprit.project, projectRoot, code: culprit.code };
}

function resolveSafeOwningRoot(
  projectId: string,
  loaderPath: string | undefined,
  projectRoots: ReadonlyMap<string, string>,
): string | undefined {
  if (loaderPath === undefined) return undefined;
  const rawRoot = projectRoots.get(projectId);
  const projectRoot = rawRoot === undefined ? undefined : normalizeSafeRelativePath(rawRoot);
  if (projectRoot === undefined || projectRoot === ".") return undefined;
  return loaderPath === projectRoot || loaderPath.startsWith(`${projectRoot}/`) ? projectRoot : undefined;
}

function buildChangeList(plan: FixPatchPlan): readonly DiagnoseFixChange[] {
  const changes: DiagnoseFixChange[] = [];
  if (plan.ignoreAdditions.length > 0) {
    changes.push({
      field: "workspace.ignorePaths",
      summary: plan.ignoreAdditions.join(", "),
      reason: "safe docs/CI fallback traps excluded from full-workspace fallback",
    });
  }
  if (plan.pureAdditions.length > 0) {
    changes.push({
      field: "workspace.pureFactories",
      summary: plan.pureAdditions.join(", "),
      reason: "known side-effect-free factory calls detected in workspace dependencies",
    });
  }
  for (const addition of plan.scopeAdditions) {
    changes.push({
      field: "workspace.dynamicImportScopes",
      summary: `${addition.loaderPath} -> ["${addition.projectRoot}"]`,
      reason: `scoped ${addition.code} in project '${addition.project}' to its project root (verify dynamic loads stay within '${addition.projectRoot}')`,
    });
  }
  return changes;
}

function buildPatchedDocument(
  document: Readonly<Record<string, unknown>>,
  workspace: Readonly<Record<string, unknown>>,
  plan: FixPatchPlan,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...workspace };
  if (plan.ignoreAdditions.length > 0) next["ignorePaths"] = mergeList(workspace["ignorePaths"], plan.ignoreAdditions);
  if (plan.pureAdditions.length > 0) next["pureFactories"] = mergeList(workspace["pureFactories"], plan.pureAdditions);
  if (plan.scopeAdditions.length > 0) {
    next["dynamicImportScopes"] = mergeDynamicScopes(
      readScopesRecord(workspace["dynamicImportScopes"]),
      plan.scopeAdditions,
    );
  }
  return { ...document, workspace: next };
}

function mergeList(existing: unknown, additions: readonly string[]): readonly string[] {
  return [...new Set([...readStringList(existing), ...additions])].sort(compareText);
}

function mergeDynamicScopes(
  existing: Readonly<Record<string, readonly string[]>>,
  additions: readonly DynamicScopeAddition[],
): Readonly<Record<string, readonly string[]>> {
  const merged: Record<string, readonly string[]> = { ...existing };
  for (const addition of additions) merged[addition.loaderPath] = [addition.projectRoot];
  const sorted: Record<string, readonly string[]> = {};
  for (const key of Object.keys(merged).sort(compareText)) {
    const entry = merged[key];
    if (entry !== undefined) sorted[key] = [...entry];
  }
  return sorted;
}

async function validateCandidateManifest(
  workspaceRoot: string,
  manifestFile: string,
  manifestPath: string,
  patchedText: string,
  nativeBinary: string | undefined,
): Promise<void> {
  const tempFile = `${manifestFile}.${randomUUID()}.tmp`;
  writeFileSync(tempFile, patchedText, "utf8");
  try {
    await planTesting({
      workspaceRoot,
      manifestPath: workspaceRelative(workspaceRoot, tempFile),
      all: true,
      taskIds: [],
      ...(nativeBinary === undefined ? {} : { nativeBinary }),
    });
  } catch (error: unknown) {
    throw new Error(
      `diagnose --fix aborted: candidate manifest failed validation (${describeError(error)}). Original ${manifestPath} was not modified.`,
      { cause: error },
    );
  } finally {
    rmSync(tempFile, { force: true });
  }
}
