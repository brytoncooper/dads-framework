import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../parse-guards.js";
import { detectWorkspace } from "./detect-workspace.js";
import { compareText } from "./infer-one-package.js";

/**
 * Static workspace detectors shared by `dad-test init --discover` and
 * `dad-test diagnose --fix`. Every detector reads declared files as text/JSON
 * without ever executing user code.
 */

export type RootVitestConfig = {
  readonly configPath?: string;
  readonly setupFiles: readonly string[];
  readonly dynamicSetupFiles: boolean;
};

type PureFactoryRule = {
  readonly packageName: string;
  readonly factories: readonly string[];
};

const pureFactoryRules: readonly PureFactoryRule[] = [
  { packageName: "class-variance-authority", factories: ["cva"] },
  { packageName: "drizzle-orm", factories: ["mysqlTable", "pgTable", "sqliteTable"] },
  { packageName: "pinia", factories: ["defineStore"] },
  { packageName: "react", factories: ["React.forwardRef", "React.memo", "createContext"] },
  { packageName: "valibot", factories: ["v.*"] },
  { packageName: "zod", factories: ["z.*"] },
];

const vitestConfigCandidates: readonly string[] = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.mjs",
  "vitest.config.js",
];

const drizzleConfigCandidates: readonly string[] = [
  "drizzle.config.ts",
  "drizzle.config.mts",
  "drizzle.config.mjs",
  "drizzle.config.js",
  "drizzle.config.cjs",
];

const standardMigrationDirs: readonly string[] = ["migrations", "drizzle", "db/migrations"];

const dependencySections: readonly string[] = ["dependencies", "devDependencies"];

/**
 * Scans root and workspace `package.json` files for dependencies with known
 * side-effect-free factory calls, returning a sorted, deduplicated list.
 */
export function detectWorkspacePureFactories(
  workspaceRoot: string,
  extraDirectories: readonly string[] = [],
): readonly string[] {
  const dependencies = collectWorkspaceDependencyNames(workspaceRoot, extraDirectories);
  const factories = new Set<string>();
  for (const rule of pureFactoryRules) {
    if (!dependencies.has(rule.packageName)) continue;
    for (const factory of rule.factories) factories.add(factory);
  }
  return [...factories].sort(compareText);
}

/**
 * Checks whether Vitest is configured or declared anywhere in the workspace.
 */
export function workspaceUsesVitest(workspaceRoot: string, extraDirectories: readonly string[] = []): boolean {
  if (findFirstExistingFile(workspaceRoot, vitestConfigCandidates) !== undefined) return true;
  if (collectWorkspaceDependencyNames(workspaceRoot, extraDirectories).has("vitest")) return true;
  return anyDirectoryHasVitestConfig(workspaceRoot, collectScanDirectories(workspaceRoot, extraDirectories));
}

/**
 * Reads a root `vitest.config.{ts,mts,mjs,js}` statically to extract literal
 * `setupFiles` paths. Dynamic expressions fail closed (`dynamicSetupFiles: true`).
 */
export function detectRootVitestConfig(workspaceRoot: string): RootVitestConfig {
  const configPath = findFirstExistingFile(workspaceRoot, vitestConfigCandidates);
  if (configPath === undefined) {
    return { setupFiles: [], dynamicSetupFiles: false };
  }
  const source = readTextSafe(join(workspaceRoot, configPath));
  if (source === undefined) {
    return { configPath, setupFiles: [], dynamicSetupFiles: true };
  }
  const extracted = extractRootVitestSetupFiles(source);
  return { configPath, ...extracted };
}

/**
 * Detects SQL migration roots from `drizzle.config.*` `out` declarations and
 * standard migration folders (`migrations/`, `drizzle/`, `db/migrations/`).
 */
export function detectSqlMigrationRoots(workspaceRoot: string): readonly string[] {
  const roots = new Set<string>();
  for (const configFile of drizzleConfigCandidates) {
    const outPath = extractDrizzleOutDir(workspaceRoot, configFile);
    if (outPath !== undefined) roots.add(outPath);
  }
  for (const directory of standardMigrationDirs) {
    if (isExistingDirectory(join(workspaceRoot, directory))) {
      roots.add(directory);
    }
  }
  return [...roots].sort(compareText);
}

/** Collects dependency names from root and workspace `package.json` files. */
export function collectWorkspaceDependencyNames(
  workspaceRoot: string,
  extraDirectories: readonly string[] = [],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const directory of collectScanDirectories(workspaceRoot, extraDirectories)) {
    const parsed = readPackageJsonRecord(workspaceRoot, directory);
    if (parsed === undefined) continue;
    addDependencyKeys(parsed, names);
  }
  return names;
}

function collectScanDirectories(workspaceRoot: string, extraDirectories: readonly string[]): readonly string[] {
  const directories = new Set<string>(["."]);
  for (const directory of extraDirectories) directories.add(directory);
  for (const directory of safeDetectedPackageDirs(workspaceRoot)) directories.add(directory);
  return [...directories].sort(compareText);
}

function safeDetectedPackageDirs(workspaceRoot: string): readonly string[] {
  try {
    return detectWorkspace(workspaceRoot).packageDirectories;
  } catch {
    return [];
  }
}

function addDependencyKeys(packageJson: Readonly<Record<string, unknown>>, out: Set<string>): void {
  for (const section of dependencySections) {
    const record = packageJson[section];
    if (!isRecord(record)) continue;
    for (const key of Object.keys(record)) out.add(key);
  }
}

function anyDirectoryHasVitestConfig(workspaceRoot: string, directories: readonly string[]): boolean {
  for (const directory of directories) {
    const base = directory === "." ? workspaceRoot : join(workspaceRoot, directory);
    if (findFirstExistingFile(base, vitestConfigCandidates) !== undefined) return true;
    const pkg = readPackageJsonRecord(workspaceRoot, directory);
    if (pkg !== undefined && packageScriptsMentionVitest(pkg)) return true;
  }
  return false;
}

function packageScriptsMentionVitest(packageJson: Readonly<Record<string, unknown>>): boolean {
  const scripts = packageJson["scripts"];
  if (!isRecord(scripts)) return false;
  for (const value of Object.values(scripts)) {
    if (typeof value === "string" && /\bvitest\b/u.test(value)) return true;
  }
  return false;
}

function readPackageJsonRecord(workspaceRoot: string, directory: string): Record<string, unknown> | undefined {
  const filePath =
    directory === "." ? join(workspaceRoot, "package.json") : join(workspaceRoot, directory, "package.json");
  const raw = readTextSafe(filePath);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractRootVitestSetupFiles(source: string): {
  readonly setupFiles: readonly string[];
  readonly dynamicSetupFiles: boolean;
} {
  const valueSlice = slicePropertyValue(source, "setupFiles");
  if (valueSlice === undefined) return { setupFiles: [], dynamicSetupFiles: false };
  const literal = parseLeadingQuotedString(valueSlice);
  if (literal !== undefined) {
    const normalized = normalizeSafeRelativePath(literal.value);
    return normalized === undefined
      ? { setupFiles: [], dynamicSetupFiles: true }
      : { setupFiles: [normalized], dynamicSetupFiles: false };
  }
  if (valueSlice.startsWith("[")) {
    return parseSetupFileArray(valueSlice);
  }
  return { setupFiles: [], dynamicSetupFiles: true };
}

function slicePropertyValue(source: string, propertyName: string): string | undefined {
  const pattern = new RegExp(`(?:^|[^\\w$])${propertyName}\\s*:`, "u");
  const match = pattern.exec(source);
  if (match === null) return undefined;
  return source.slice(match.index + match[0].length).trimStart();
}

function parseSetupFileArray(valueSlice: string): {
  readonly setupFiles: readonly string[];
  readonly dynamicSetupFiles: boolean;
} {
  const closeIndex = valueSlice.indexOf("]");
  if (closeIndex === -1) return { setupFiles: [], dynamicSetupFiles: true };
  let cursor = valueSlice.slice(1, closeIndex).trim();
  const files = new Set<string>();
  while (cursor.length > 0) {
    const item = parseLeadingQuotedString(cursor);
    const normalized = item === undefined ? undefined : normalizeSafeRelativePath(item.value);
    if (item === undefined || normalized === undefined) {
      return { setupFiles: [], dynamicSetupFiles: true };
    }
    files.add(normalized);
    const nextCursor = advancePastArraySeparator(item.rest);
    if (nextCursor === undefined) return { setupFiles: [], dynamicSetupFiles: true };
    cursor = nextCursor;
  }
  return { setupFiles: [...files].sort(compareText), dynamicSetupFiles: false };
}

function advancePastArraySeparator(rest: string): string | undefined {
  const trimmed = rest.trimStart();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith(",")) return trimmed.slice(1).trimStart();
  return undefined;
}

function parseLeadingQuotedString(input: string): { readonly value: string; readonly rest: string } | undefined {
  const quote = input[0];
  if (quote !== "'" && quote !== '"') return undefined;
  const endIndex = input.indexOf(quote, 1);
  if (endIndex === -1) return undefined;
  const value = input.slice(1, endIndex);
  if (value.includes("\n") || value.includes("\r")) return undefined;
  return { value, rest: input.slice(endIndex + 1) };
}

function extractDrizzleOutDir(workspaceRoot: string, configFile: string): string | undefined {
  const source = readTextSafe(join(workspaceRoot, configFile));
  if (source === undefined) return undefined;
  const valueSlice = slicePropertyValue(source, "out");
  if (valueSlice === undefined) return undefined;
  const parsed = parseLeadingQuotedString(valueSlice);
  return parsed === undefined ? undefined : normalizeSafeRelativePath(parsed.value);
}

/** Normalizes a workspace-relative path, rejecting empty, absolute, or parent-traversing paths. */
export function normalizeSafeRelativePath(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith("/") || trimmed.includes("${") || trimmed.includes("*")) {
    return undefined;
  }
  const parts: string[] = [];
  for (const segment of trimmed.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return undefined;
    parts.push(segment);
  }
  return parts.length === 0 ? undefined : parts.join("/");
}

function findFirstExistingFile(directory: string, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (isExistingFile(join(directory, candidate))) return candidate;
  }
  return undefined;
}

function isExistingFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isExistingDirectory(dirPath: string): boolean {
  try {
    return existsSync(dirPath) && statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readTextSafe(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}
