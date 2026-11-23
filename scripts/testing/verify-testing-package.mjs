import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { buildTestingHostBinary } from "./build-testing-host-binary.mjs";

import {
  installCleanConsumer,
  runCleanConsumerCli,
  runCleanConsumerNx,
  runCleanConsumerPlan,
} from "./verify-testing-package-consumer.mjs";
import { packPackage, readJson, requireFile, verifyPackedContents } from "./verify-testing-package-lib.mjs";

const args = process.argv.slice(2);
const buildHost = args.length === 1 && args[0] === "--build-host";
if (args.length !== 0 && !buildHost) throw new Error("Usage: verify-testing-package.mjs [--build-host]");
import {
  assertNativeNoticeLock,
  stageNativePackageNotices,
  verifyNativePackageNotices,
} from "./native-package-notices.mjs";

const root = resolve(process.cwd());
if (buildHost) {
  execFileSync(process.execPath, ["node_modules/typescript-native/bin/tsc", "-b", "packages/testing/core"], {
    cwd: root,
    stdio: "inherit",
  });
}
const packageRoot = join(root, "packages", "testing", "core");
const facadeManifestPath = join(packageRoot, "package.json");
const facadeManifest = readJson(facadeManifestPath);
if (facadeManifest.name !== "@dads-framework/testing" || facadeManifest.bin?.["dad-test"] !== "./bin/dad-test.js") {
  throw new Error("Testing package public identity is incomplete.");
}

const facadeDist = join(packageRoot, "dist");
for (const requiredFile of ["index.js", "cli.js", "native-platform.js"]) {
  requireFile(join(facadeDist, requiredFile), "already-built testing dist");
}

const nativePlatform = await import(pathToFileURL(join(facadeDist, "native-platform.js")).href);
const nativePackageName = nativePlatform.nativePackageNameForPlatform();
const nativePlatformDirectoryName = nativePackageName.replace("@dads-framework/testing-native-", "");
const nativePackageRoot = join(root, "packages", "testing", "native", nativePlatformDirectoryName);
if (lstatSync(nativePackageRoot).isSymbolicLink()) {
  throw new Error(`Refusing to verify a symlinked host native package directory: ${nativePackageRoot}`);
}
const nativeManifest = readJson(join(nativePackageRoot, "package.json"));
const nativeBinaryName = process.platform === "win32" ? "dad-test.exe" : "dad-test";
const temporaryRoot = mkdtempSync(join(tmpdir(), "dads-testing-package-proof-"));
try {
  if (dirname(temporaryRoot) !== resolve(tmpdir())) {
    throw new Error(`Refusing to use an unexpected temporary path: ${temporaryRoot}`);
  }
  const proofPackageRoot = buildHost
    ? stageTestingPackage(root, nativePackageRoot, nativeBinaryName, temporaryRoot)
    : nativePackageRoot;
  assertNativeBinary(proofPackageRoot);
  assertNativeNoticeLock(root);
  verifyNativePackageNotices(root, proofPackageRoot);
  const packedDirectory = join(temporaryRoot, "packed");
  const consumerDirectory = join(temporaryRoot, "consumer");
  mkdirSync(packedDirectory, { recursive: true });
  mkdirSync(consumerDirectory, { recursive: true });
  const facadeTarball = packPackage(root, packageRoot, packedDirectory, facadeManifest, "facade");
  const nativeTarball = packPackage(root, proofPackageRoot, packedDirectory, nativeManifest, "native");
  verifyPackedContents(facadeTarball, "facade", facadeManifest, nativePackageName);
  verifyPackedContents(nativeTarball, "native", nativeManifest, nativePackageName);
  installCleanConsumer(consumerDirectory, facadeTarball, nativeTarball, nativePackageName);
  runCleanConsumerPlan(consumerDirectory);
  runCleanConsumerCli(consumerDirectory);
  runCleanConsumerNx(consumerDirectory);
  process.stdout.write(
    `Packed testing facade and ${nativePackageName}; clean consumer plan, CLI, and Nx entrypoints passed.\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function assertNativeBinary(packageDirectory) {
  const nativeBinaryPath = join(packageDirectory, "bin", nativeBinaryName);
  requireFile(nativeBinaryPath, `built executable for ${nativePackageName}`);
  if (lstatSync(nativeBinaryPath).isSymbolicLink()) {
    throw new Error(`Refusing to verify a symlinked host native executable: ${nativeBinaryPath}`);
  }
  if (process.platform !== "win32" && (statSync(nativeBinaryPath).mode & 0o111) === 0) {
    throw new Error(`Built native executable is not executable: ${nativeBinaryPath}`);
  }
}

function stageTestingPackage(root, source, name, temporaryRoot) {
  const executable = buildTestingHostBinary(root);
  const packageDirectory = join(temporaryRoot, "native-package");
  const binaryDirectory = join(packageDirectory, "bin");
  mkdirSync(binaryDirectory, { recursive: true });
  for (const file of ["package.json", "README.md"]) {
    copyFileSync(join(source, file), join(packageDirectory, file));
  }
  const binary = join(binaryDirectory, name);
  copyFileSync(executable, binary);
  stageNativePackageNotices(root, packageDirectory);
  if (process.platform !== "win32") chmodSync(binary, 0o755);
  return packageDirectory;
}
