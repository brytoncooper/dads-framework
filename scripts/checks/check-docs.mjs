import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { checkDocsSite } from "../docs/site-build.mjs";

/**
 * Documentation conformance. Two questions, both answered from the repository
 * rather than from a reviewer's memory:
 *
 * 1. Does every package or exported subpath listed in `docs/readme-conformance.json` have a README
 *    shaped like `docs/package-readme-template.md`?
 * 2. Does the `@dads-framework/testing` README still cover the whole `dad-test`
 *    command line, as the built CLI reports it?
 *
 * The second question is why the command list is passed in rather than read
 * here: the check runs against the compiled surface in `npm run verify`, and
 * against injected fixtures in its own tests.
 */

const CONFORMANCE_FILE = "docs/readme-conformance.json";
const REFUSAL_HEADING = "What it refuses to do";
const CLI_PACKAGE_NAME = "@dads-framework/testing";
const CLI_ENTRY_FILE = "packages/testing/core/dist/dad-test-cli.js";

/**
 * Reads the structural facts a conformant README has to satisfy in one pass.
 * Fenced blocks are tracked so example markdown inside a code block cannot
 * satisfy a heading requirement.
 */
function readStructure(text) {
  let insideFence = false;
  let firstContentLine;
  let sawFirstLevel2Heading = false;
  let paragraphBeforeFirstLevel2Heading = false;
  let fenceLineCount = 0;
  const level2Headings = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("```")) {
      fenceLineCount += 1;
      insideFence = !insideFence;
      firstContentLine ??= line;
      continue;
    }
    if (insideFence || line.length === 0) continue;

    if (firstContentLine === undefined) {
      firstContentLine = line;
      continue;
    }
    if (line.startsWith("## ")) {
      sawFirstLevel2Heading = true;
      level2Headings.push(line.slice("## ".length).trim());
      continue;
    }
    if (line.startsWith("#")) continue;
    if (!sawFirstLevel2Heading) paragraphBeforeFirstLevel2Heading = true;
  }

  return {
    firstContentLine,
    paragraphBeforeFirstLevel2Heading,
    fenceLineCount,
    level2Headings,
  };
}

/** Problems with a README's shape, each phrased to follow `<path>: `. */
export function checkReadmeStructure(text) {
  const structure = readStructure(text);
  if (structure.firstContentLine === undefined) return ["is empty"];

  const problems = [];
  if (!/^#\s+\S/.test(structure.firstContentLine)) {
    problems.push("first non-empty line is not an H1 heading");
  }
  if (!structure.paragraphBeforeFirstLevel2Heading) {
    problems.push("no paragraph between the H1 and the first H2 heading");
  }
  if (structure.fenceLineCount < 2) {
    problems.push("no fenced code block");
  }
  if (!structure.level2Headings.includes(REFUSAL_HEADING)) {
    problems.push(`no "## ${REFUSAL_HEADING}" heading`);
  }
  return problems;
}

/**
 * Problems with the `dad-test` README's coverage of the command line. An
 * option is reported once, naming every command that accepts it, so a rename
 * of a shared option is one line rather than four.
 */
export function checkCommandCoverage(text, commands) {
  const problems = [];
  const commandsByMissingOption = new Map();

  for (const command of commands) {
    const invocation = `dad-test ${command.name}`;
    if (!text.includes(invocation)) {
      problems.push(`does not document \`${invocation}\``);
    }
    for (const option of command.options) {
      if (text.includes(option)) continue;
      const accepting = commandsByMissingOption.get(option) ?? [];
      accepting.push(command.name);
      commandsByMissingOption.set(option, accepting);
    }
  }

  for (const [option, accepting] of commandsByMissingOption) {
    problems.push(
      `does not document ${option} (accepted by ${accepting.join(", ")})`,
    );
  }
  return problems;
}

function readConformancePackages(root) {
  const conformancePath = join(root, CONFORMANCE_FILE);
  let raw;
  try {
    raw = readFileSync(conformancePath, "utf8");
  } catch (error) {
    throw new Error(`${CONFORMANCE_FILE} could not be read: ${error.message}`, {
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${CONFORMANCE_FILE} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }

  const names = parsed?.packages;
  const isNameList =
    Array.isArray(names) &&
    names.every((name) => typeof name === "string" && name.length > 0) &&
    new Set(names).size === names.length;
  if (!isNameList) {
    throw new Error(
      `${CONFORMANCE_FILE} must contain a "packages" array of unique package names or export subpaths`,
    );
  }
  return names;
}

/**
 * Maps every package name under `packages/` to its directory, written the way
 * a reader would type it: `http/core`, `testing/native/darwin-arm64`. Packages
 * sit at whatever depth their domain folder puts them, so the walk descends
 * until it finds a manifest and stops there: a package never contains one.
 */
function readPackageDirectories(root) {
  const directoriesByName = new Map();

  const visit = (directory) => {
    const manifestPath = join(root, "packages", directory, "package.json");

    let raw;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      for (const entry of readdirSync(join(root, "packages", directory), {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        visit(directory === "" ? entry.name : `${directory}/${entry.name}`);
      }
      return;
    }

    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `packages/${directory}/package.json is not valid JSON: ${error.message}`,
        { cause: error },
      );
    }

    if (typeof manifest?.name === "string") {
      directoriesByName.set(manifest.name, {
        directory,
        exports: manifest.exports,
      });
    }
  };

  visit("");
  return directoriesByName;
}

function readmePathFor(name, directoriesByName) {
  const segments = name.split("/");
  const packageName = segments
    .splice(0, name.startsWith("@") ? 2 : 1)
    .join("/");
  const owner = directoriesByName.get(packageName);
  if (!owner) return undefined;
  if (segments.length === 0) return `packages/${owner.directory}/README.md`;
  if (!segments.every((segment) => /^[\w-]+$/u.test(segment))) return undefined;
  const subpath = segments.join("/");
  if (!Object.hasOwn(owner.exports ?? {}, `./${subpath}`)) return undefined;
  return `packages/${owner.directory}/${subpath}/README.md`;
}

/**
 * Checks every listed package or subpath README against the template, and the `dad-test`
 * README against `commands`. Returns the process result rather than exiting so
 * the tests can assert on it.
 */
export function checkDocs({ root, commands }) {
  const packageNames = readConformancePackages(root);
  const directoriesByName = readPackageDirectories(root);
  const problems = [];
  let checkedPackageCount = 0;

  for (const packageName of packageNames) {
    const readmePath = readmePathFor(packageName, directoriesByName);
    if (readmePath === undefined) {
      problems.push(
        `${CONFORMANCE_FILE}: no package or exported subpath under packages/ is named ${packageName}`,
      );
      continue;
    }

    let text;
    try {
      text = readFileSync(join(root, readmePath), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      problems.push(`${readmePath}: missing`);
      continue;
    }

    checkedPackageCount += 1;
    for (const problem of checkReadmeStructure(text)) {
      problems.push(`${readmePath}: ${problem}`);
    }
    if (packageName === CLI_PACKAGE_NAME) {
      for (const problem of checkCommandCoverage(text, commands)) {
        problems.push(`${readmePath}: ${problem}`);
      }
    }
  }

  if (problems.length > 0) {
    return { exitCode: 1, output: `${problems.join("\n")}\n` };
  }
  return {
    exitCode: 0,
    output: `docs: conformant (${checkedPackageCount} packages, ${commands.length} commands)\n`,
  };
}

/** Reads the `dad-test` command surface from the built CLI. */
export async function loadDadTestCommands(root) {
  const entryUrl = pathToFileURL(join(root, CLI_ENTRY_FILE)).href;
  const module = await import(entryUrl);
  if (typeof module.listDadTestCommands !== "function") {
    throw new Error(`${CLI_ENTRY_FILE} does not export listDadTestCommands()`);
  }
  return module.listDadTestCommands();
}

function resolveRoot(argv) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex !== -1 && argv[rootIndex + 1]) {
    return resolve(argv[rootIndex + 1]);
  }
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

export async function main(argv) {
  const root = resolveRoot(argv);

  let commands;
  try {
    commands = await loadDadTestCommands(root);
  } catch (error) {
    return {
      exitCode: 1,
      output: `${CLI_ENTRY_FILE}: could not be read; build the workspace first (${error.message})\n`,
    };
  }

  const readmes = checkDocs({ root, commands });
  if (readmes.exitCode !== 0) return readmes;
  try {
    return { exitCode: 0, output: readmes.output + checkDocsSite(root) };
  } catch (error) {
    return { exitCode: 1, output: `docs health: ${error.message}\n` };
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const result = await main(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}
