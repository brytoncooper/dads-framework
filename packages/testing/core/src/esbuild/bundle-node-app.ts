/**
 * Standalone Node.js esbuild runner with transitive `package.json` /
 * `package-lock.json` pruning and post-build bundle safety checks.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "../parse-guards.js";
import {
  buildPrunedManifests,
  collectRuntimeDependencies,
  type EsbuildMetafile,
  type RootLockfile,
  type RootPackageJson,
} from "./prune-lockfile.js";

export type EsbuildLike = {
  readonly build: (options: Readonly<Record<string, unknown>>) => Promise<{ readonly metafile?: EsbuildMetafile }>;
};

export type BundleSafetyCheck =
  | { readonly kind: "forbid-pattern"; readonly pattern: RegExp; readonly label: string }
  | { readonly kind: "forbid-substring"; readonly substring: string; readonly label: string }
  | { readonly kind: "boot-no-error-substring"; readonly substring: string; readonly timeoutMs?: number };

export type BundleNodeTarget = {
  readonly name: string;
  readonly entry: string;
  readonly outputPath: string;
  readonly outputFileName: string;
  readonly tsconfig: string;
  readonly external?: readonly string[];
  readonly extraRuntimeDeps?: readonly string[];
  readonly generatePackageJson?: boolean;
  readonly writeMetafile?: boolean;
  readonly format?: "cjs" | "esm";
  readonly sourcemap?: boolean;
  readonly define?: Readonly<Record<string, string>>;
  readonly extraEsbuildOptions?: Readonly<Record<string, unknown>>;
  readonly checks?: readonly BundleSafetyCheck[];
};

export type BundleNodeResult = {
  readonly outfile: string;
  readonly runtimeDeps: readonly string[];
};

/** Bundles a Node.js target with the caller's `esbuild` instance and optional pruned Docker manifests. */
export async function bundleNodeApp(input: {
  readonly esbuild: EsbuildLike;
  readonly workspaceRoot: string;
  readonly target: BundleNodeTarget;
}): Promise<BundleNodeResult> {
  const { workspaceRoot, target } = input;
  const outputDir = resolve(workspaceRoot, target.outputPath);
  const outfile = join(outputDir, target.outputFileName);
  mkdirSync(outputDir, { recursive: true });

  const format = target.format ?? "cjs";
  const result = await input.esbuild.build(buildEsbuildOptions(workspaceRoot, target, outfile, format));

  if (target.writeMetafile === true && result.metafile !== undefined) {
    writeFileSync(join(outputDir, "meta.json"), JSON.stringify(result.metafile, null, 2), "utf8");
  }
  const runtimeDeps =
    target.generatePackageJson === true && result.metafile !== undefined
      ? writePrunedNodeManifests(workspaceRoot, outputDir, target, format, result.metafile)
      : [];

  runBundleSafetyChecks(target.name, outfile, target.checks ?? []);
  return { outfile, runtimeDeps };
}

function buildEsbuildOptions(
  workspaceRoot: string,
  target: BundleNodeTarget,
  outfile: string,
  format: "cjs" | "esm",
): Readonly<Record<string, unknown>> {
  const extra = target.extraEsbuildOptions ?? {};
  const extraDefine = isRecord(extra["define"]) ? extra["define"] : {};
  return {
    absWorkingDir: workspaceRoot,
    entryPoints: [resolve(workspaceRoot, target.entry)],
    outfile,
    bundle: true,
    platform: "node",
    format,
    sourcemap: target.sourcemap ?? true,
    metafile: true,
    tsconfig: resolve(workspaceRoot, target.tsconfig),
    external: [...(target.external ?? [])],
    ...extra,
    define: { ...extraDefine, ...(target.define ?? {}) },
  };
}

function writePrunedNodeManifests(
  workspaceRoot: string,
  outputDir: string,
  target: BundleNodeTarget,
  format: "cjs" | "esm",
  metafile: EsbuildMetafile,
): readonly string[] {
  const rootPackageJson = readBundleRootPackageJson(resolve(workspaceRoot, "package.json"));
  const rootLockfile = readBundleRootLockfile(resolve(workspaceRoot, "package-lock.json"));
  const runtimeDeps = collectRuntimeDependencies({
    metafile,
    rootPackageJson,
    ...(target.external === undefined ? {} : { external: target.external }),
    ...(target.extraRuntimeDeps === undefined ? {} : { extraRuntimeDeps: target.extraRuntimeDeps }),
  });
  const { prunedPackageJson, prunedPackageLock } = buildPrunedManifests({
    packageName: target.name,
    main: `./${target.outputFileName}`,
    type: format === "esm" ? "module" : "commonjs",
    runtimeDeps,
    rootPackageJson,
    rootLockfile,
  });
  writeFileSync(join(outputDir, "package.json"), `${JSON.stringify(prunedPackageJson, null, 2)}\n`, "utf8");
  writeFileSync(join(outputDir, "package-lock.json"), `${JSON.stringify(prunedPackageLock, null, 2)}\n`, "utf8");
  return runtimeDeps;
}

/** Runs post-build safety checks against an emitted bundle file. */
export function runBundleSafetyChecks(targetName: string, outfile: string, checks: readonly BundleSafetyCheck[]): void {
  if (checks.length === 0) return;
  const content = readFileSync(outfile, "utf8");
  for (const check of checks) {
    executeOneSafetyCheck(targetName, outfile, content, check);
  }
}

function executeOneSafetyCheck(targetName: string, outfile: string, content: string, check: BundleSafetyCheck): void {
  if (check.kind === "forbid-pattern") {
    if (check.pattern.test(content)) {
      throw new Error(`${targetName} bundle failed check "${check.label}".`);
    }
    return;
  }
  if (check.kind === "forbid-substring") {
    if (content.includes(check.substring)) {
      throw new Error(`${targetName} bundle failed check "${check.label}".`);
    }
    return;
  }
  const result = spawnSync(process.execPath, [outfile], {
    cwd: tmpdir(),
    timeout: check.timeoutMs ?? 5_000,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "" },
  });
  if (`${result.stdout}${result.stderr}`.includes(check.substring)) {
    throw new Error(`${targetName} bundle failed boot check for "${check.substring}".`);
  }
}

function readBundleRootPackageJson(filePath: string): RootPackageJson {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${filePath} must be a JSON object.`);
  const dependencies: Record<string, string> = {};
  if (isRecord(parsed["dependencies"])) {
    for (const [k, v] of Object.entries(parsed["dependencies"])) {
      if (typeof v === "string") dependencies[k] = v;
    }
  }
  const packageManager = typeof parsed["packageManager"] === "string" ? parsed["packageManager"] : undefined;
  return { dependencies, ...(packageManager === undefined ? {} : { packageManager }) };
}

function readBundleRootLockfile(filePath: string): RootLockfile {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${filePath} must be a JSON object.`);
  const packages: Record<string, Readonly<Record<string, unknown>>> = {};
  if (isRecord(parsed["packages"])) {
    for (const [k, v] of Object.entries(parsed["packages"])) {
      if (isRecord(v)) packages[k] = v;
    }
  }
  const lockfileVersion = typeof parsed["lockfileVersion"] === "number" ? parsed["lockfileVersion"] : undefined;
  return { packages, ...(lockfileVersion === undefined ? {} : { lockfileVersion }) };
}
