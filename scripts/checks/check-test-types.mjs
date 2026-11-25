/**
 * Compiles every `*.test.ts` in the workspace under its own package's
 * strictness, which nothing else in the gate does.
 *
 * Each package `tsconfig.json` ends with `"exclude": ["src/**\/*.test.ts"]`,
 * because a test must never reach `dist`. That exclusion also means `tsc -b`
 * never opens a test file: ESLint's typed rules report rule violations rather
 * than type errors, and Vitest strips types instead of checking them. So a test
 * could call a function with the wrong arguments, or assert against a shape the
 * production type no longer has, and every check stayed green. Two such errors
 * were found by hand in one week.
 *
 * The shape. One root project cannot do this job: `lib` differs per package
 * (`DOM` in the client, React Query, workbench, and agent-workbench packages),
 * `types` differs, `rootDir` and `outDir` collide, and two fixtures do not
 * extend `tsconfig.base.json` at all. A test has to be compiled under the
 * options its own package compiles under, or the gate is measuring a different
 * language than the one the package ships. So the unit is a sibling
 * `tsconfig.tests.json` per package: it extends the package's own
 * `tsconfig.json`, drops the exclusion, and adds `noEmit` with
 * `composite: false` so nothing is written and no `.tsbuildinfo` can collide
 * with `tsc -b`. Every one of those files is identical, which is the point:
 * the options come from the package, not from here.
 *
 * They add exactly one option the packages do not set: `types: ["node"]`.
 * Every test in this workspace runs under Vitest on Node, and the ten packages
 * that already declare it declare exactly that. The ones that do not were
 * reaching Node's types by accident, through a `/// <reference types="node">`
 * inside some dependency's declarations, so whether `node:fs` resolved in a
 * test depended on what that package's dependencies happened to drag in.
 * Naming the types is what makes the run reproducible.
 *
 * The projects are discovered rather than listed, so a new package is in the
 * gate the day it is written. Discovery alone would go quiet on a package that
 * owns tests and has no `tsconfig.tests.json`, so the pairing is checked both
 * ways first: a package with test files must have one, and a package without
 * test files must not keep a stale one. That check fails before a single
 * compiler runs.
 *
 * Cross-package imports resolve through `node_modules` into each package's
 * emitted `dist/*.d.ts`, exactly as the four `type-tests` projects do, so the
 * workspace has to be built first.
 *
 *   node scripts/checks/check-test-types.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cacheKey, hasPassed, openStepCache, writeRecord } from "../verify-cache.mjs";
import { dadTestClosureKey, loadDadTestCacheClosures } from "../verify-dad-test.mjs";

const TSC = "node_modules/typescript-native/bin/tsc";
const TESTS_PROJECT = "tsconfig.tests.json";

/** The workspace locations from the root `package.json`. */
const WORKSPACE_ROOTS = [
  { directory: "packages", depth: 2 },
  { directory: "fixtures", depth: 1 },
  { directory: "apps", depth: 1 },
];

function repositoryRoot() {
  return resolve(fileURLToPath(import.meta.url), "..", "..", "..");
}

function subdirectories(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Every workspace package directory, relative to the repository root. */
export function listPackageDirectories(root) {
  const directories = [];
  for (const { directory, depth } of WORKSPACE_ROOTS) {
    for (const name of subdirectories(join(root, directory))) {
      const path = join(directory, name);
      if (depth === 1 || existsSync(join(root, path, "package.json"))) {
        directories.push(path);
        continue;
      }
      for (const child of subdirectories(join(root, path))) {
        directories.push(join(path, child));
      }
    }
  }
  return directories;
}

function ownsTestFiles(root, packageDirectory) {
  const source = join(root, packageDirectory, "src");
  if (!existsSync(source)) return false;
  return readdirSync(source, { recursive: true })
    .map(String)
    .some((entry) => /\.test\.tsx?$/.test(entry));
}

/**
 * Which packages own test files, which declare a tests project, and where the
 * two disagree. A disagreement is the failure mode discovery cannot see.
 */
export function planTestProjects({ root, packageDirectories }) {
  const projects = [];
  const missing = [];
  const stale = [];

  for (const packageDirectory of packageDirectories) {
    const declared = existsSync(join(root, packageDirectory, TESTS_PROJECT));
    const owns = ownsTestFiles(root, packageDirectory);

    if (owns && !declared) {
      missing.push(packageDirectory);
      continue;
    }
    if (!owns && declared) {
      stale.push(packageDirectory);
      continue;
    }
    if (owns) projects.push(join(packageDirectory, TESTS_PROJECT));
  }

  return { projects, missing, stale };
}

function describePairingProblems({ missing, stale }) {
  const lines = [];
  for (const packageDirectory of missing) {
    lines.push(`${packageDirectory}: owns test files but has no ${TESTS_PROJECT}; ` + `no gate compiles them`);
  }
  for (const packageDirectory of stale) {
    lines.push(`${packageDirectory}: has a ${TESTS_PROJECT} but owns no test files; ` + `delete it`);
  }
  return lines;
}

function compileProject({ root, project }) {
  const result = spawnSync(process.execPath, compileArguments(project), {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  return {
    project,
    ok: result.status === 0,
    output: `${result.stdout}${result.stderr}`.trim(),
  };
}

function compileArguments(project) {
  return [TSC, "-p", project, "--pretty", "false"];
}

/**
 * Under `npm run verify` with its cache, a project whose package scope passed
 * before is not compiled again (`scripts/verify-cache.mjs`); run by hand, or
 * under CI, every project compiles.
 */
function compileOrReuse({ root, project, cache, closures }) {
  if (cache === null) return { ...compileProject({ root, project }), cached: false };
  const directory = dirname(project);
  const command = [process.execPath, ...compileArguments(project)];
  const closure = closures?.get(directory);
  const key =
    closure !== undefined
      ? dadTestClosureKey(cache, closure, command)
      : cacheKey(cache, { kind: "package", directory, staticOnly: true }, command);
  if (hasPassed(cache, "test-types", directory, key)) {
    return { project, ok: true, output: "", cached: true };
  }
  const result = compileProject({ root, project });
  if (result.ok && key !== null) writeRecord(cache, "test-types", directory, { key });
  return { ...result, cached: false };
}

function cacheSentence(cache, results) {
  if (cache === null) return "";
  const cached = results.filter((result) => result.cached).length;
  if (cached === results.length) return "verify-cache: hit\n";
  return `verify-cache: ${String(cached)} of ${String(results.length)} projects cached\n`;
}

export function checkTestTypes({ root, cache = null }) {
  const plan = planTestProjects({
    root,
    packageDirectories: listPackageDirectories(root),
  });

  const pairingProblems = describePairingProblems(plan);
  if (pairingProblems.length > 0) {
    return {
      exitCode: 1,
      output: `${["test type projects out of step with the packages:", ...pairingProblems].join("\n")}\n`,
    };
  }

  const closures = cache === null ? null : loadDadTestCacheClosures(root, cache.environment, "typecheck");
  const results = plan.projects.map((project) => compileOrReuse({ root, project, cache, closures }));
  const failures = results.filter((result) => !result.ok);
  const note = cacheSentence(cache, results);

  if (failures.length > 0) {
    const reports = failures.map((failure) => `--- ${failure.project}\n${failure.output}`);
    return {
      exitCode: 1,
      output: `${["test files that do not typecheck:", ...reports].join("\n")}\n${note}`,
    };
  }

  return {
    exitCode: 0,
    output: `test types: clean (${String(plan.projects.length)} projects)\n${note}`,
  };
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const root = repositoryRoot();
  const result = checkTestTypes({
    root,
    cache: openStepCache(root, process.env),
  });
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}
