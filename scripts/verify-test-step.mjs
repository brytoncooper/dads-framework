/**
 * The `test` step of `npm run verify`: Vitest over the whole workspace, cached
 * one package at a time.
 *
 * Without a verify cache (CI, `--no-cache`, `--full`, or run by hand) it is
 * exactly the one Vitest run it always was. With one, each package that owns
 * test files is keyed on its own scope (`verify-workspace.mjs`): a package
 * whose key passed before is left out, and Vitest runs only the rest, filtered
 * by directory. A package is recorded when every one of its test files passed.
 *
 * The Vitest JSON report stays complete either way, because the `test-count`
 * floor in `source-budgets` reads it: the suites of a skipped package come
 * from its record, the rest from this run. A test file that belongs to no
 * workspace package turns the partitioning off and runs everything.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { cacheKey, hasPassed, openStepCache, readRecord, writeRecord } from "./verify-cache.mjs";
import { readWorkspace } from "./verify-workspace.mjs";

const ROOT = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const VITEST = "node_modules/vitest/vitest.mjs";
const REPORT = "node_modules/.dads/vitest-report.json";
const BASE_ARGS = ["run", "--reporter=default", "--reporter=json"];
/**
 * Default upper bound on concurrent Vitest workers so Docker-backed integration
 * suites do not starve Docker Desktop on high-core laptops. Override with
 * `VITEST_MAX_WORKERS=<n>` when benchmarking or tuning a host.
 */
const DEFAULT_MAX_WORKERS = 4;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u;
const NOT_COLLECTED = /(?:^|\/)(?:node_modules|dist)\/|\.test\.mjs$/u;

export function resolveVitestMaxWorkers(env = process.env, parallelism = availableParallelism()) {
  const configured = env.VITEST_MAX_WORKERS?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  return String(Math.max(1, Math.min(DEFAULT_MAX_WORKERS, parallelism)));
}

function runVitest(extraArgs) {
  const maxWorkers = resolveVitestMaxWorkers();
  const run = spawnSync(process.execPath, [VITEST, ...BASE_ARGS, `--maxWorkers=${maxWorkers}`, ...extraArgs], {
    cwd: ROOT,
    stdio: "inherit",
  });
  return run.status ?? 1;
}

/** The most specific package directory holding `path`. */
function ownerOf(path, directories) {
  let best;
  for (const directory of directories) {
    if (!path.startsWith(`${directory}/`)) continue;
    if (best === undefined || directory.length > best.length) best = directory;
  }
  return best;
}

/** Every package that owns a test file, keyed; null if a file has no owner. */
export function planTestPackages(cache) {
  const workspace = readWorkspace(cache.root, cache.fingerprint.entries);
  const directories = [...workspace.keys()];
  const candidates = [
    ...Object.keys(cache.fingerprint.entries),
    ...cache.fingerprint.ignored.map(([path]) => path),
  ].filter((path) => TEST_FILE.test(path) && !NOT_COLLECTED.test(path));
  const owners = new Set();
  for (const path of candidates) {
    const owner = ownerOf(path, directories);
    if (owner === undefined) return null;
    owners.add(owner);
  }
  const command = [process.execPath, VITEST, ...BASE_ARGS];
  return [...owners].sort().map((directory) => ({
    directory,
    key: cacheKey(cache, { kind: "package", directory }, command),
  }));
}

function relativeName(suite) {
  return suite.name.startsWith(`${ROOT}/`) ? suite.name.slice(ROOT.length + 1) : suite.name;
}

function suitesOf(report, directory) {
  return report.testResults.filter((suite) => relativeName(suite).startsWith(`${directory}/`));
}

function recordPasses(cache, ran, report) {
  for (const { directory, key } of ran) {
    const suites = suitesOf(report, directory);
    if (key === null || suites.length === 0) continue;
    if (suites.some((suite) => suite.status !== "passed")) continue;
    const relative = suites.map((suite) => ({
      ...suite,
      name: relativeName(suite),
    }));
    writeRecord(cache, "test", directory, { key, suites: relative });
  }
}

/** The report `test-count` reads: this run's suites plus the cached ones. */
function writeMergedReport(fresh, cachedSuites) {
  const testResults = [...fresh, ...cachedSuites];
  const failed = testResults.filter((suite) => suite.status === "failed").length;
  const merged = {
    numTotalTestSuites: testResults.length,
    numFailedTestSuites: failed,
    numPassedTestSuites: testResults.length - failed,
    success: failed === 0,
    testResults,
  };
  mkdirSync(dirname(join(ROOT, REPORT)), { recursive: true });
  writeFileSync(join(ROOT, REPORT), `${JSON.stringify(merged)}\n`);
}

function cachedSuites(cache, packages) {
  return packages.flatMap(({ directory }) =>
    (readRecord(cache, "test", directory)?.suites ?? []).map((suite) => ({
      ...suite,
      name: `${ROOT}/${suite.name}`,
    })),
  );
}

function readReport(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function runPartitioned(cache, plan) {
  const cached = plan.filter(({ directory, key }) => hasPassed(cache, "test", directory, key));
  const toRun = plan.filter((item) => !cached.includes(item));
  const note = `${String(cached.length)} of ${String(plan.length)} packages cached`;
  if (toRun.length === 0) {
    writeMergedReport([], cachedSuites(cache, cached));
    process.stdout.write(`verify-cache: hit\n`);
    return 0;
  }
  const freshPath = join(cache.directory, "runs", cache.runId, "vitest-report.json");
  const exitCode = runVitest([`--outputFile=${freshPath}`, ...toRun.map(({ directory }) => `${directory}/`)]);
  const fresh = readReport(freshPath);
  if (fresh === null) return exitCode === 0 ? 1 : exitCode;
  recordPasses(cache, toRun, fresh);
  writeMergedReport(fresh.testResults, cachedSuites(cache, cached));
  process.stdout.write(`verify-cache: ${note}\n`);
  return exitCode;
}

/** A plan that cannot be made means no partitions: everything runs. */
function planOrNothing(cache) {
  try {
    return planTestPackages(cache);
  } catch {
    return null;
  }
}

function main() {
  const cache = openStepCache(ROOT, process.env);
  const plan = cache === null ? null : planOrNothing(cache);
  if (plan === null) return runVitest([`--outputFile=${REPORT}`]);
  return runPartitioned(cache, plan);
}

const isMainModule = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
