/**
 * Inspecting Vite/Vitest configs for Nx eject: detects `nxViteTsPaths()` usage,
 * extracts statically verifiable `setupFiles` for fail-closed Vitest file
 * narrowing, and optionally rewrites `nxViteTsPaths()` to `dadsTsconfigPaths()`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const defaultConfigNames = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
];

const nxViteImportPattern =
  /^import\s+\{\s*nxViteTsPaths\s*\}\s+from\s+(['"])@nx\/vite\/plugins\/nx-tsconfig-paths\.plugin\1\s*;?\s*$/m;
const nxViteAnyMentionPattern = /\bnxViteTsPaths\b/;
const nxVitePlainCallPattern = /\bnxViteTsPaths\s*\(\s*\)/g;
const nxViteAnyCallPattern = /\bnxViteTsPaths\s*\([^)]*\)/g;
const setupFilesMentionPattern = /\bsetupFiles\s*:/;
const setupFilesLiteralArrayPattern = /\bsetupFiles\s*:\s*\[([^\]]*)\]/;
const setupFilesSingleStringPattern = /\bsetupFiles\s*:\s*(['"])([^'"\n]+)\1/;

export type VitestConfigInspection = {
  readonly configPath?: string;
  readonly usesNxViteTsPaths: boolean;
  readonly setupFiles: readonly string[];
  /** True when `setupFiles` exists in config but could not be statically resolved (disables fileNarrowing). */
  readonly dynamicSetupFiles: boolean;
};

export type RewriteNxViteResult = {
  readonly configPath: string;
  readonly status: "rewritten" | "already-clean" | "manual-review-needed";
  readonly detail: string;
};

/** Inspects a project's Vite/Vitest config without executing it. */
export function inspectVitestConfig(
  workspaceRoot: string,
  projectRoot: string,
  configuredPath?: string,
): VitestConfigInspection {
  const configPath = resolveVitestConfigPath(workspaceRoot, projectRoot, configuredPath);
  if (configPath === undefined) {
    return { usesNxViteTsPaths: false, setupFiles: [], dynamicSetupFiles: false };
  }
  const absolute = path.join(workspaceRoot, configPath);
  if (!existsSync(absolute)) {
    return { configPath, usesNxViteTsPaths: false, setupFiles: [], dynamicSetupFiles: true };
  }
  const source = readFileSync(absolute, "utf8");
  const usesNxViteTsPaths = nxViteAnyMentionPattern.test(source);
  const setup = extractStaticSetupFiles(source, projectRoot);
  return {
    configPath,
    usesNxViteTsPaths,
    setupFiles: setup.paths,
    dynamicSetupFiles: setup.dynamic,
  };
}

/** Resolves the workspace root tsconfig file that `dadsTsconfigPaths` should read. */
export function detectWorkspaceTsconfig(workspaceRoot: string): string {
  if (existsSync(path.join(workspaceRoot, "tsconfig.base.json"))) return "tsconfig.base.json";
  return "tsconfig.json";
}

/**
 * Rewrites clean `nxViteTsPaths()` imports and zero-argument calls to
 * `dadsTsconfigPaths({ tsconfig: fileURLToPath(new URL(..., import.meta.url)) })`.
 * Any complex invocation (custom arguments, aliased imports) is left untouched
 * and flagged for manual review.
 */
export function rewriteNxViteTsPaths(
  workspaceRoot: string,
  configRelativePath: string,
  workspaceTsconfig: string,
): RewriteNxViteResult {
  const absolute = path.join(workspaceRoot, configRelativePath);
  const source = readFileSync(absolute, "utf8");
  if (!nxViteAnyMentionPattern.test(source)) {
    return { configPath: configRelativePath, status: "already-clean", detail: "No nxViteTsPaths usage found." };
  }
  if (!nxViteImportPattern.test(source) || hasNonTrivialNxViteCall(source)) {
    return {
      configPath: configRelativePath,
      status: "manual-review-needed",
      detail: "Custom nxViteTsPaths import or options detected; replace with dadsTsconfigPaths manually.",
    };
  }
  const rewritten = applyNxViteReplacement(source, configRelativePath, workspaceTsconfig);
  writeFileSync(absolute, rewritten, "utf8");
  return {
    configPath: configRelativePath,
    status: "rewritten",
    detail: `Replaced nxViteTsPaths() with dadsTsconfigPaths({ tsconfig: ${workspaceTsconfig} }).`,
  };
}

function resolveVitestConfigPath(
  workspaceRoot: string,
  projectRoot: string,
  configuredPath?: string,
): string | undefined {
  if (configuredPath !== undefined && configuredPath.trim() !== "") {
    const cleaned = configuredPath.replace(/^\{projectRoot\}\/?/, "").replace(/^\{workspaceRoot\}\/?/, "");
    const candidate = configuredPath.startsWith("{workspaceRoot}")
      ? cleaned
      : projectRoot === "."
        ? cleaned
        : path.posix.join(projectRoot, cleaned);
    return normalizePosix(candidate);
  }
  for (const name of defaultConfigNames) {
    const relative = projectRoot === "." ? name : path.posix.join(projectRoot, name);
    if (existsSync(path.join(workspaceRoot, relative))) return relative;
  }
  return undefined;
}

function extractStaticSetupFiles(
  source: string,
  projectRoot: string,
): { readonly paths: readonly string[]; readonly dynamic: boolean } {
  if (!setupFilesMentionPattern.test(source)) return { paths: [], dynamic: false };
  const single = setupFilesSingleStringPattern.exec(source);
  if (single?.[2] !== undefined) {
    const resolved = resolveSetupPath(projectRoot, single[2]);
    return resolved === undefined ? { paths: [], dynamic: true } : { paths: [resolved], dynamic: false };
  }
  const arrayMatch = setupFilesLiteralArrayPattern.exec(source);
  if (arrayMatch?.[1] === undefined) return { paths: [], dynamic: true };
  return parseSetupArrayBody(arrayMatch[1], projectRoot);
}

function parseSetupArrayBody(
  body: string,
  projectRoot: string,
): { readonly paths: readonly string[]; readonly dynamic: boolean } {
  const trimmed = body.trim();
  if (trimmed === "") return { paths: [], dynamic: false };
  const parts = trimmed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const paths: string[] = [];
  for (const part of parts) {
    const match = /^(['"])([^'"\n]+)\1$/.exec(part);
    if (match?.[2] === undefined) return { paths: [], dynamic: true };
    const resolved = resolveSetupPath(projectRoot, match[2]);
    if (resolved === undefined) return { paths: [], dynamic: true };
    paths.push(resolved);
  }
  return { paths: [...new Set(paths)].sort(), dynamic: false };
}

function resolveSetupPath(projectRoot: string, entry: string): string | undefined {
  if (entry.startsWith("/") || entry.includes("${") || entry.includes("*")) return undefined;
  const joined = projectRoot === "." ? entry : path.posix.join(projectRoot, entry);
  const normalized = normalizePosix(joined);
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

function hasNonTrivialNxViteCall(source: string): boolean {
  const allCalls = source.match(nxViteAnyCallPattern) ?? [];
  const plainCalls = source.match(nxVitePlainCallPattern) ?? [];
  return allCalls.length === 0 || allCalls.length !== plainCalls.length;
}

function applyNxViteReplacement(source: string, configRelativePath: string, workspaceTsconfig: string): string {
  const configDir = path.posix.dirname(configRelativePath);
  const relativeTsconfig = path.posix.relative(configDir, workspaceTsconfig);
  const specifier = relativeTsconfig.startsWith(".") ? relativeTsconfig : `./${relativeTsconfig}`;
  const hasFileUrlImport = /\bfileURLToPath\b/.test(source);
  const importReplacement = hasFileUrlImport
    ? 'import { dadsTsconfigPaths } from "@dads-framework/testing/vitest";'
    : 'import { fileURLToPath } from "node:url";\nimport { dadsTsconfigPaths } from "@dads-framework/testing/vitest";';
  const callReplacement = `dadsTsconfigPaths({ tsconfig: fileURLToPath(new URL(${JSON.stringify(specifier)}, import.meta.url)) })`;
  return source.replace(nxViteImportPattern, importReplacement).replace(nxVitePlainCallPattern, callReplacement);
}

function normalizePosix(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}
