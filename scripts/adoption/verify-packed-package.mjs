import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { consolidatedPackageProof } from "./consolidated-package-proof.mjs";

const requestedPackage = process.argv[2];
if (!requestedPackage) {
  throw new Error("Expected a workspace package name.");
}

const workspacePackages = loadWorkspacePackages();
if (!workspacePackages.has(requestedPackage)) {
  throw new Error(`Workspace ${requestedPackage} was not found.`);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "dads-packed-"));
const tarballRoot = join(temporaryRoot, "tarballs");
const fixtureRoot = join(temporaryRoot, "consumer");
mkdirSync(tarballRoot);
mkdirSync(fixtureRoot);

try {
  const installOrder = collectInternalDependencies(requestedPackage, workspacePackages);
  const tarballs = installOrder.map(packWorkspacePackage);
  writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({ private: true, type: "module" }), { flag: "wx" });
  for (const tarball of tarballs) {
    execFileSync("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund", tarball], {
      cwd: fixtureRoot,
      stdio: "inherit",
    });
  }

  const installedManifest = readJson(join(fixtureRoot, "node_modules", requestedPackage, "package.json"));
  if (installedManifest.name !== requestedPackage) {
    throw new Error(`Installed ${String(installedManifest.name)}, expected ${requestedPackage}.`);
  }
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      consolidatedPackageProof(requestedPackage) ?? `await import(${JSON.stringify(requestedPackage)})`,
    ],
    { cwd: fixtureRoot, stdio: "inherit" },
  );
  if (requestedPackage === "@dads-framework/toolbox") {
    verifyDadExecutable(fixtureRoot);
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function verifyDadExecutable(fixtureRoot) {
  const executableRoot = join(fixtureRoot, "node_modules", ".bin");
  const dadExecutable = join(executableRoot, "dad");
  if (!existsSync(dadExecutable)) {
    throw new Error("The packed toolbox package did not install the dad CLI.");
  }
  if (existsSync(join(executableRoot, "dads"))) {
    throw new Error("The packed toolbox package still installs a dads CLI.");
  }
  const completed = spawnSync(dadExecutable, [], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
  if (completed.status !== 1 || !completed.stderr.startsWith("Dad: Usage: dad init")) {
    throw new Error(`The packed dad CLI did not report its expected usage. ${completed.stderr}`);
  }
}

/**
 * Every package under `packages/`, at whatever depth its domain folder puts
 * it. The walk stops at the first `package.json`: a package never contains
 * another one.
 */
function loadWorkspacePackages() {
  const packages = new Map();
  const visit = (directory) => {
    let manifest;
    try {
      manifest = readJson(join(directory, "package.json"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "node_modules") continue;
        visit(join(directory, entry.name));
      }
      return;
    }
    if (typeof manifest.name === "string") {
      packages.set(manifest.name, { directory, manifest });
    }
  };
  visit("packages");
  return packages;
}

function collectInternalDependencies(packageName, packages, collected = []) {
  const workspacePackage = packages.get(packageName);
  if (!workspacePackage) {
    throw new Error(`Missing workspace declaration for ${packageName}.`);
  }
  const dependencies = workspacePackage.manifest.dependencies ?? {};
  for (const dependencyName of Object.keys(dependencies)) {
    if (packages.has(dependencyName) && !collected.includes(dependencyName)) {
      collectInternalDependencies(dependencyName, packages, collected);
    }
  }
  if (!collected.includes(packageName)) {
    collected.push(packageName);
  }
  return collected;
}

function packWorkspacePackage(packageName) {
  execFileSync("npm", ["run", "build", "-w", packageName], {
    stdio: "inherit",
  });
  const packOutput = execFileSync("npm", ["pack", "-w", packageName, "--json", "--pack-destination", tarballRoot], {
    encoding: "utf8",
  });
  const packed = JSON.parse(packOutput);
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") {
    throw new Error(`npm pack did not return a tarball for ${packageName}.`);
  }
  return join(tarballRoot, filename);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
