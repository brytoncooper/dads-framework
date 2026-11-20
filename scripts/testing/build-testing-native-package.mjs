import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import {
  assertNativeNoticeLock,
  stageNativePackageNotices,
} from "./native-package-notices.mjs";

const argumentsAfterScript = process.argv.slice(2);
const target = readOption("--target");
const packageDirectory = readOption("--package-dir");
if (
  target === undefined ||
  packageDirectory === undefined ||
  argumentsAfterScript.length !== 4
) {
  throw new Error(
    "Usage: node scripts/testing/build-testing-native-package.mjs --target <rust-target> --package-dir <native-package-dir>",
  );
}

const root = resolve(process.cwd());
const packageRoot = resolve(root, packageDirectory);
const manifestPath = join(packageRoot, "package.json");
const manifest = readJson(manifestPath);
const packageName = requiredString(manifest.name, `${manifestPath}: name`);
const executableName =
  process.platform === "win32" || target.includes("windows")
    ? "dad-test.exe"
    : "dad-test";
const cargoBinary = join(root, "target", target, "release", executableName);
const destination = join(packageRoot, "bin", executableName);

assertNativeNoticeLock(root);
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--package",
    "dad-test",
    "--target",
    target,
  ],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (!readableFile(cargoBinary)) {
  throw new Error(
    `Cargo completed without producing the expected native binary: ${cargoBinary}`,
  );
}
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(cargoBinary, destination);
stageNativePackageNotices(root, packageRoot);
if (!target.includes("windows")) chmodSync(destination, 0o755);
process.stdout.write(
  `Built ${packageName} native runtime at ${destination}.\n`,
);

function readOption(name) {
  const index = argumentsAfterScript.indexOf(name);
  if (index < 0) return undefined;
  const value = argumentsAfterScript[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${name} requires a value.`);
  return value;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read native package manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function readableFile(path) {
  try {
    return readFileSync(path).length > 0;
  } catch {
    return false;
  }
}
