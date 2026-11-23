#!/usr/bin/env node
/**
 * Public surface report: what every publishable package promises, written
 * down where a reviewer can diff it.
 *
 * For each package under `packages/` that declares `publishConfig`, this
 * command reads the emitted declarations and writes `api-report.md` beside the
 * package: one line per export, with the declaration text as emitted, so a
 * change to the surface *is* the diff. The reading and the rendering live in
 * `generate-api-report-lib.mjs`; this file is the command around them.
 *
 * Default mode writes the reports. `--check` writes nothing and fails with a
 * diff when a committed report no longer matches the code; that is the mode
 * `verify` runs, after `typecheck` has emitted `dist/`. `--package <name>`
 * narrows the run to one package and `--json` prints machine-readable output.
 *
 * The report records each package's `published` flag from `dads.project.json`
 * so the policy is visible in the file the reviewer is reading. While the flag
 * is false, drift means regenerate. Once it is true, a removed or narrowed
 * line is a breaking change — that rule lives in `docs/house-rules.md` and is
 * enforced by review, not by this command.
 *
 *   node scripts/checks/generate-api-report.mjs
 *   node scripts/checks/generate-api-report.mjs --check
 *   node scripts/checks/generate-api-report.mjs --package @dads-framework/http
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { REGENERATE_HINT, ReportError, buildReport, compareStrings, diffLines } from "./generate-api-report-lib.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES_DIRECTORY = "packages";
const PROJECT_FILE = "dads.project.json";
const REPORT_FILE = "api-report.md";
const FLAGS = new Set(["--check", "--json"]);
const OPTIONS = new Set(["--package"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function toPosix(path) {
  return path.split("\\").join("/");
}

/** Splits `argv` into known flags and known `--name value` options. */
export function parseArguments(argv) {
  const flags = new Set();
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (FLAGS.has(argument)) {
      flags.add(argument);
      continue;
    }
    if (!OPTIONS.has(argument)) {
      throw new ReportError(`Unknown argument ${argument}.`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new ReportError(`${argument} needs a value.`);
    options.set(argument, value);
    index += 1;
  }
  return { flags, options };
}

// ---------------------------------------------------------------------------
// What to report on
// ---------------------------------------------------------------------------

function directoryNames(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareStrings);
}

/**
 * Every package under `packages/<group>/<name>` that declares
 * `publishConfig` — the packages that have a public surface to report on.
 */
export function discoverPackages(root) {
  const packagesRoot = join(root, PACKAGES_DIRECTORY);
  const found = [];
  for (const group of directoryNames(packagesRoot)) {
    for (const name of directoryNames(join(packagesRoot, group))) {
      const directory = join(packagesRoot, group, name);
      const manifestPath = join(directory, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = readJson(manifestPath);
      if (manifest.publishConfig === undefined) continue;
      found.push({
        directory,
        manifest,
        name: manifest.name,
        reportPath: `${PACKAGES_DIRECTORY}/${group}/${name}/${REPORT_FILE}`,
      });
    }
  }
  return found.sort((left, right) => compareStrings(left.reportPath, right.reportPath));
}

/**
 * The `published` flag per package, keyed by both project root and package
 * name. A package the project file does not mention is not published.
 */
export function readPublishedFlags(root) {
  const path = join(root, PROJECT_FILE);
  const flags = new Map();
  if (!existsSync(path)) return flags;
  for (const entry of readJson(path).packages ?? []) {
    const published = entry.published === true;
    if (typeof entry.root === "string") flags.set(entry.root, published);
    if (typeof entry.name === "string") flags.set(entry.name, published);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function reviewPackage(packageEntry, { root, publishedFlags, check }) {
  const relativeDirectory = toPosix(relative(root, packageEntry.directory));
  const published = publishedFlags.get(relativeDirectory) ?? publishedFlags.get(packageEntry.name) ?? false;
  const report = buildReport(packageEntry, published);
  const reportPath = join(packageEntry.directory, REPORT_FILE);
  const committed = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  const changed = committed !== report.text;
  if (changed && !check) writeFileSync(reportPath, report.text);
  return {
    changed,
    diff: changed && check ? diffLines(committed, report.text) : [],
    entryPoints: report.sections.length,
    exports: report.sections.reduce((total, section) => total + section.exports.length, 0),
    name: packageEntry.name,
    published,
    report: packageEntry.reportPath,
  };
}

function renderOutput({ json, check, reviewed, errors }) {
  const drifted = reviewed.filter((entry) => entry.changed);
  const ok = errors.length === 0 && (!check || drifted.length === 0);

  if (json) {
    const payload = {
      ok,
      mode: check ? "check" : "write",
      packages: reviewed,
      ...(errors.length > 0 ? { errors } : {}),
    };
    return { exitCode: ok ? 0 : 1, output: `${JSON.stringify(payload)}\n` };
  }

  const lines = [];
  for (const entry of check ? drifted : reviewed) {
    if (check) {
      lines.push(`--- ${entry.report} (committed)`, `+++ ${entry.report} (regenerated)`, ...entry.diff);
      continue;
    }
    const state = entry.changed ? "written" : "unchanged";
    lines.push(`${entry.report}: ${entry.exports} exports across ` + `${entry.entryPoints} entry points (${state})`);
  }
  lines.push(...errors);

  if (drifted.length > 0 && check) {
    lines.push(`api-report: ${drifted.length} report(s) out of date. ${REGENERATE_HINT}`);
  } else if (ok) {
    lines.push(
      check
        ? `api-report: clean (${reviewed.length} packages)`
        : `api-report: ${drifted.length} of ${reviewed.length} reports rewritten`,
    );
  }
  return { exitCode: ok ? 0 : 1, output: `${lines.join("\n")}\n` };
}

/** Runs the command and returns what to print and what to exit with. */
export function main(argv, { root = REPO_ROOT } = {}) {
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    if (!(error instanceof ReportError)) throw error;
    return { exitCode: 1, output: `${error.message}\n` };
  }

  const check = parsed.flags.has("--check");
  const json = parsed.flags.has("--json");
  const only = parsed.options.get("--package");

  let packages = discoverPackages(root);
  if (only !== undefined) {
    packages = packages.filter((entry) => entry.name === only);
    if (packages.length === 0) {
      const errors = [`No publishable package is named ${only}.`];
      return renderOutput({ json, check, reviewed: [], errors });
    }
  }

  const publishedFlags = readPublishedFlags(root);
  const reviewed = [];
  const errors = [];
  for (const packageEntry of packages) {
    try {
      reviewed.push(reviewPackage(packageEntry, { root, publishedFlags, check }));
    } catch (error) {
      if (!(error instanceof ReportError)) throw error;
      errors.push(error.message);
    }
  }
  return renderOutput({ json, check, reviewed, errors });
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}
