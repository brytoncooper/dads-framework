import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  assertNativeNoticeLock,
  nativeNoticeFiles,
  verifyNativePackageNotices,
} from "./native-package-notices.mjs";

const root = process.cwd();
assertNativeNoticeLock(root);
const requestedDirectory = readOption("--package-dir");
const metadataOnly = process.argv.includes("--metadata-only");
const definitions = [
  {
    directory: "packages/testing/native/darwin-arm64",
    name: "@dads-framework/testing-native-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    binary: "dad-test",
  },
  {
    directory: "packages/testing/native/darwin-x64",
    name: "@dads-framework/testing-native-darwin-x64",
    os: "darwin",
    cpu: "x64",
    binary: "dad-test",
  },
  {
    directory: "packages/testing/native/linux-arm64-gnu",
    name: "@dads-framework/testing-native-linux-arm64-gnu",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    binary: "dad-test",
  },
  {
    directory: "packages/testing/native/linux-x64-gnu",
    name: "@dads-framework/testing-native-linux-x64-gnu",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    binary: "dad-test",
  },
  {
    directory: "packages/testing/native/win32-x64",
    name: "@dads-framework/testing-native-win32-x64",
    os: "win32",
    cpu: "x64",
    binary: "dad-test.exe",
  },
];

const facadePath = join(root, "packages", "testing", "core", "package.json");
const facade = readJson(facadePath);
const { version } = facade;
if (typeof version !== "string" || version.length === 0) {
  throw new Error("Testing facade is missing its version.");
}
const expectedOptionalDependencies = Object.fromEntries(
  definitions.map(({ name }) => [name, version]),
);
if (
  JSON.stringify(facade.optionalDependencies) !==
  JSON.stringify(expectedOptionalDependencies)
) {
  throw new Error(
    "Testing facade optionalDependencies do not exactly match the five native packages.",
  );
}

const definitionsToVerify =
  requestedDirectory === undefined
    ? definitions
    : definitions.filter(
        (definition) => definition.directory === requestedDirectory,
      );
if (definitionsToVerify.length === 0) {
  throw new Error(`Unknown native package directory: ${requestedDirectory}`);
}

for (const definition of definitionsToVerify) {
  const packageRoot = join(root, definition.directory);
  const manifestPath = join(packageRoot, "package.json");
  const manifest = readJson(manifestPath);
  if (
    manifest.name !== definition.name ||
    manifest.version !== version ||
    manifest.license !== facade.license
  ) {
    throw new Error(
      `${manifestPath} has an incorrect name, version, or license (expected ${facade.license}).`,
    );
  }
  if (
    !sameSingleValue(manifest.os, definition.os) ||
    !sameSingleValue(manifest.cpu, definition.cpu)
  ) {
    throw new Error(`${manifestPath} has incorrect npm os/cpu metadata.`);
  }
  const expectedLibc =
    definition.libc === undefined ? undefined : [definition.libc];
  if (JSON.stringify(manifest.libc) !== JSON.stringify(expectedLibc)) {
    throw new Error(
      `${manifestPath} must declare libc ${definition.libc ?? "only non-Linux"}.`,
    );
  }
  if (
    manifest.dependencies !== undefined ||
    manifest.devDependencies !== undefined ||
    manifest.peerDependencies !== undefined
  ) {
    throw new Error(
      `${manifestPath} must not carry runtime, development, or peer dependencies.`,
    );
  }
  const expectedFiles = [
    `bin/${definition.binary}`,
    "README.md",
    ...nativeNoticeFiles,
  ];
  if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `${manifestPath} must publish only its executable, README and license notices.`,
    );
  }
  if (
    manifest.exports?.["."] !== `./bin/${definition.binary}` ||
    manifest.bin?.["dad-test"] !== `./bin/${definition.binary}`
  ) {
    throw new Error(`${manifestPath} has incorrect executable exports.`);
  }
  if (!existsSync(join(packageRoot, "README.md")))
    throw new Error(`Missing native package README: ${packageRoot}`);
  if (!metadataOnly) {
    verifyNativePackageNotices(root, packageRoot);
    const binaryPath = join(packageRoot, "bin", definition.binary);
    if (!existsSync(binaryPath) || !statFile(binaryPath))
      throw new Error(`Missing native executable: ${binaryPath}`);
    const binaryDirectory = join(packageRoot, "bin");
    const unexpectedBinaries = readdirSync(binaryDirectory).filter(
      (entry) => entry !== definition.binary,
    );
    if (unexpectedBinaries.length > 0)
      throw new Error(
        `${binaryDirectory} contains unexpected files: ${unexpectedBinaries.join(", ")}.`,
      );
  }
  const unexpected = readdirSync(packageRoot).filter(
    (entry) =>
      !["package.json", "README.md", "bin", ...nativeNoticeFiles].includes(
        entry,
      ),
  );
  if (unexpected.length > 0)
    throw new Error(
      `${packageRoot} contains unexpected files: ${unexpected.join(", ")}.`,
    );
}
process.stdout.write(
  metadataOnly
    ? "All Dads Testing native package metadata is valid.\n"
    : "All Dads Testing native package metadata and artifacts are valid.\n",
);

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${name} requires a value.`);
  return value;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function sameSingleValue(value, expected) {
  return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

function statFile(path) {
  try {
    return statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}
