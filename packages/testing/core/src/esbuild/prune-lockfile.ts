/**
 * Pure runtime-dependency collection and npm lockfileVersion-3 pruning for
 * bundled Node.js applications (Docker `npm ci --omit=dev`).
 */
import { isRecord } from "../parse-guards.js";

export type EsbuildMetafileImport = {
  readonly path?: string;
  readonly original?: string;
};

export type EsbuildMetafileInput = {
  readonly imports?: readonly EsbuildMetafileImport[];
};

export type EsbuildMetafile = {
  readonly inputs?: Readonly<Record<string, EsbuildMetafileInput>>;
};

export type RootPackageJson = {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly packageManager?: string;
};

export type LockfilePackageEntry = Readonly<Record<string, unknown>>;

export type RootLockfile = {
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, LockfilePackageEntry>>;
};

export type PrunedManifests = {
  readonly prunedPackageJson: Readonly<Record<string, unknown>>;
  readonly prunedPackageLock: Readonly<Record<string, unknown>>;
};

/** Extracts the npm package name from a bare specifier or `node_modules/...` path. */
export function packageNameFromSpecifier(specifier: string): string | undefined {
  if (
    specifier.length === 0 ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:")
  ) {
    return undefined;
  }
  const normalized = specifier.replace(/^.*node_modules\//, "");
  const parts = normalized.split("/");
  const first = parts[0];
  if (first === undefined || first.length === 0) return undefined;
  if (first.startsWith("@")) {
    const second = parts[1];
    return second !== undefined && second.length > 0 ? `${first}/${second}` : undefined;
  }
  return first;
}

/**
 * Collects the sorted set of root `dependencies` needed at runtime by an esbuild
 * bundle: declared `external` packages, packages referenced by the esbuild
 * metafile that appear in root `dependencies`, and any explicit `extraRuntimeDeps`.
 */
export function collectRuntimeDependencies(input: {
  readonly external?: readonly string[];
  readonly extraRuntimeDeps?: readonly string[];
  readonly metafile: EsbuildMetafile;
  readonly rootPackageJson: RootPackageJson;
}): readonly string[] {
  const rootDeps = input.rootPackageJson.dependencies ?? {};
  const wanted = new Set<string>();
  addSpecifiers(input.external ?? [], wanted, undefined);
  addSpecifiers(input.extraRuntimeDeps ?? [], wanted, rootDeps);
  collectMetafilePackages(input.metafile, rootDeps, wanted);
  return [...wanted].sort();
}

function addSpecifiers(
  specifiers: readonly string[],
  wanted: Set<string>,
  rootDeps: Readonly<Record<string, string>> | undefined,
): void {
  for (const spec of specifiers) {
    const pkg = packageNameFromSpecifier(spec);
    if (pkg === undefined) continue;
    if (rootDeps === undefined || Object.hasOwn(rootDeps, pkg)) wanted.add(pkg);
  }
}

function collectMetafilePackages(
  metafile: EsbuildMetafile,
  rootDeps: Readonly<Record<string, string>>,
  wanted: Set<string>,
): void {
  for (const [inputPath, info] of Object.entries(metafile.inputs ?? {})) {
    if (inputPath.includes("node_modules/")) {
      recordIfRootDep(inputPath, rootDeps, wanted);
      continue;
    }
    for (const imp of info.imports ?? []) {
      recordIfRootDep(imp.original ?? imp.path ?? "", rootDeps, wanted);
    }
  }
}

function recordIfRootDep(specifier: string, rootDeps: Readonly<Record<string, string>>, wanted: Set<string>): void {
  const pkg = packageNameFromSpecifier(specifier);
  if (pkg !== undefined && Object.hasOwn(rootDeps, pkg)) wanted.add(pkg);
}

/**
 * Prunes a workspace root lockfileVersion-3 `package-lock.json` down to the exact
 * transitive runtime closure of `runtimeDeps`, clearing `dev` and `devOptional`
 * flags so `npm ci --omit=dev` installs every required package deterministically.
 */
export function buildPrunedManifests(input: {
  readonly packageName: string;
  readonly main?: string;
  readonly type?: "commonjs" | "module";
  readonly runtimeDeps: readonly string[];
  readonly rootPackageJson: RootPackageJson;
  readonly rootLockfile: RootLockfile;
}): PrunedManifests {
  const allPackages = input.rootLockfile.packages ?? {};
  const { kept, dependencies } = seedDirectRuntimeDeps(input.runtimeDeps, allPackages);
  expandTransitiveClosure(allPackages, kept);

  const packageManager = input.rootPackageJson.packageManager;
  const prunedPackageJson: Record<string, unknown> = {
    name: input.packageName,
    version: "0.0.1",
    dependencies,
    ...(packageManager === undefined ? {} : { packageManager }),
    main: input.main ?? "./main.cjs",
    type: input.type ?? "commonjs",
  };
  const prunedPackageLock = assemblePrunedLockfile(
    input.packageName,
    dependencies,
    packageManager,
    input.rootLockfile.lockfileVersion ?? 3,
    kept,
  );
  return { prunedPackageJson, prunedPackageLock };
}

function seedDirectRuntimeDeps(
  runtimeDeps: readonly string[],
  allPackages: Readonly<Record<string, LockfilePackageEntry>>,
): {
  readonly kept: Map<string, LockfilePackageEntry>;
  readonly dependencies: Record<string, string>;
} {
  const kept = new Map<string, LockfilePackageEntry>();
  const dependencies: Record<string, string> = {};
  for (const dep of runtimeDeps) {
    const key = resolveLockEntryKey(allPackages, "", dep);
    if (key === undefined) {
      throw new Error(`Runtime dependency "${dep}" was not found in root package-lock.json.`);
    }
    const entry = allPackages[key];
    if (entry === undefined) continue;
    const version = entry["version"];
    if (typeof version !== "string") {
      throw new Error(`Lockfile entry "${key}" is missing a string version.`);
    }
    dependencies[dep] = version;
    kept.set(key, entry);
  }
  return { kept, dependencies };
}

function expandTransitiveClosure(
  allPackages: Readonly<Record<string, LockfilePackageEntry>>,
  kept: Map<string, LockfilePackageEntry>,
): void {
  const queue = [...kept.keys()];
  for (let idx = 0; idx < queue.length; idx += 1) {
    const currentKey = queue[idx];
    if (currentKey === undefined) continue;
    const entry = kept.get(currentKey);
    if (entry === undefined) continue;
    enqueueChildLockEntries(allPackages, currentKey, entry, kept, queue);
  }
}

const lockDependencyFields: readonly string[] = ["dependencies", "optionalDependencies", "peerDependencies"];

function enqueueChildLockEntries(
  allPackages: Readonly<Record<string, LockfilePackageEntry>>,
  parentKey: string,
  entry: LockfilePackageEntry,
  kept: Map<string, LockfilePackageEntry>,
  queue: string[],
): void {
  for (const field of lockDependencyFields) {
    const childMap = entry[field];
    if (!isRecord(childMap)) continue;
    for (const childName of Object.keys(childMap)) {
      const resolved = resolveLockEntryKey(allPackages, parentKey, childName);
      if (resolved === undefined || kept.has(resolved)) continue;
      const childEntry = allPackages[resolved];
      if (childEntry === undefined) continue;
      kept.set(resolved, childEntry);
      queue.push(resolved);
    }
  }
}

function resolveLockEntryKey(
  allPackages: Readonly<Record<string, LockfilePackageEntry>>,
  parentKey: string,
  depName: string,
): string | undefined {
  let cursor = parentKey;
  for (;;) {
    const candidate = cursor === "" ? `node_modules/${depName}` : `${cursor}/node_modules/${depName}`;
    if (Object.hasOwn(allPackages, candidate)) return candidate;
    if (cursor === "") return undefined;
    const idx = cursor.lastIndexOf("/node_modules/");
    cursor = idx === -1 ? "" : cursor.slice(0, idx);
  }
}

function assemblePrunedLockfile(
  packageName: string,
  dependencies: Readonly<Record<string, string>>,
  packageManager: string | undefined,
  lockfileVersion: number,
  kept: ReadonlyMap<string, LockfilePackageEntry>,
): Readonly<Record<string, unknown>> {
  const sortedPackages: Record<string, unknown> = {
    "": {
      name: packageName,
      version: "0.0.1",
      dependencies,
      ...(packageManager === undefined ? {} : { packageManager }),
    },
  };
  for (const key of [...kept.keys()].sort()) {
    const entry = kept.get(key);
    if (entry === undefined) continue;
    sortedPackages[key] = stripDevLockFlags(entry);
  }
  return { name: packageName, version: "0.0.1", lockfileVersion, requires: true, packages: sortedPackages };
}

function stripDevLockFlags(entry: LockfilePackageEntry): Readonly<Record<string, unknown>> {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === "dev" || k === "devOptional") continue;
    copy[k] = v;
  }
  return copy;
}
