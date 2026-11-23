/**
 * The isolated project the boundary proof runs against, and the edits it makes
 * to it.
 *
 * The fixture is copied to a temporary directory with every built and vendored
 * artifact stripped, given a git history of its own, and then mutated one
 * scenario at a time. Nothing here knows what a scenario expects — that lives
 * in `verify-boundary-verification-expectations.mjs`, and the scenario list
 * itself lives in `verify-boundary-verification-scenarios.mjs`.
 *
 * One project is prepared and taken to its committed baseline; every scenario
 * after that gets its own byte-for-byte copy of that baseline, made by
 * `copyPreparedProject`, and edits it without anyone else seeing it.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, statSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The `consumer:artifact-check` task's execution block inside a manifest. */
export function controlledConsumer(manifest) {
  return manifest.verification.tasks.find((task) => task.id === "consumer:artifact-check").execution;
}

export function createBoundaryProject({ projectRoot, fixtureSource, lockfileSource, accessPackageSource }) {
  function git(argumentsForGit) {
    const completed = spawnSync("git", argumentsForGit, {
      cwd: projectRoot,
      encoding: "utf8",
    });
    if (completed.status !== 0 || completed.error) {
      throw new Error(`${completed.stderr}\n${completed.stdout}`.trim());
    }
    return completed.stdout;
  }

  function copyAccessDependencies() {
    const manifest = JSON.parse(readFileSync(join(accessPackageSource, "package.json"), "utf8"));
    const required = Object.keys(manifest.dependencies ?? {});
    // Looked up only when there is something to look up: the workspace copy of
    // the authorization package sits in `packages/`, not under a
    // `node_modules/`, and asking where its peers live before knowing whether
    // it has any is what made the proof unrunnable outside the packed proof.
    if (required.length === 0) return;
    const sourceNodeModules = findPackageNodeModules(accessPackageSource);
    for (const peerName of required) {
      const source = join(sourceNodeModules, peerName);
      if (!existsSync(source)) {
        throw new Error(`Packed access dependency ${peerName} is missing beside ${accessPackageSource}.`);
      }
      const target = join(projectRoot, "node_modules", peerName);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
    }
  }

  function consumerReceipts() {
    const receiptRoot = join(projectRoot, ".dads/verification/receipts");
    return listFiles(receiptRoot).filter((path) =>
      readFileSync(path, "utf8").includes('"taskId":"consumer:artifact-check"'),
    );
  }

  return {
    prepareIsolatedProject() {
      cpSync(fixtureSource, projectRoot, {
        recursive: true,
        filter: (source) =>
          !["dist", ".dads"].includes(basename(source)) &&
          !source.includes("verification/compiled") &&
          !source.includes("verification/generated") &&
          !source.includes("verification/vendor"),
      });
      // Resolve access through its installed package in the disposable project.
      const tsconfigPath = join(projectRoot, "tsconfig.json");
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
      delete tsconfig.references;
      writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
      cpSync(lockfileSource, join(projectRoot, "package-lock.json"));
      const accessPackageRoot = join(projectRoot, "node_modules/@dads-framework/access");
      mkdirSync(accessPackageRoot, { recursive: true });
      cpSync(join(accessPackageSource, "package.json"), join(accessPackageRoot, "package.json"));
      cpSync(join(accessPackageSource, "dist"), join(accessPackageRoot, "dist"), { recursive: true });
      copyAccessDependencies();
      const vendorRoot = join(projectRoot, "verification/vendor/access");
      mkdirSync(vendorRoot, { recursive: true });
      cpSync(join(accessPackageSource, "dist"), vendorRoot, {
        recursive: true,
        // Every emitted module except the testing and catalog entry points,
        // whatever folders the package splits itself into.
        filter: (source) =>
          !source.includes("/testing/") &&
          !source.includes("/catalog/") &&
          !source.endsWith("/authorization-explanation-schema.js") &&
          (statSync(source).isDirectory() || source.endsWith(".js")),
      });
      // Keep fixture setup commits off refs/heads/main, which verification
      // captures as history evidence and includes in receipt identity.
      git(["init", "--initial-branch=boundary-proof"]);
      git(["config", "user.email", "boundary-verification@example.test"]);
      git(["config", "user.name", "Boundary Verification"]);
      git(["add", "--all", "--force"]);
      git(["commit", "-m", "fixture baseline"]);
    },

    append(path, suffix) {
      const absolutePath = join(projectRoot, path);
      writeFileSync(absolutePath, `${readFileSync(absolutePath, "utf8")}${suffix}`);
    },

    read(path) {
      return readFileSync(join(projectRoot, path), "utf8");
    },

    write(path, contents) {
      writeFileSync(join(projectRoot, path), contents);
    },

    replace(path, before, after) {
      const absolutePath = join(projectRoot, path);
      const source = readFileSync(absolutePath, "utf8");
      if (!source.includes(before)) {
        throw new Error(`Expected replacement source in ${path}.`);
      }
      writeFileSync(absolutePath, source.replace(before, after));
    },

    updateManifest(update) {
      const path = join(projectRoot, "dads.project.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      update(manifest);
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    },

    removeConsumerReceipts() {
      for (const receipt of consumerReceipts()) rmSync(receipt);
    },

    corruptConsumerReceipts() {
      const receipts = consumerReceipts();
      if (receipts.length === 0) throw new Error("No consumer receipt to corrupt.");
      for (const receipt of receipts) writeFileSync(receipt, "{corrupt\n");
    },

    commit(message) {
      git(["add", "--all", "--force"]);
      git(["commit", "-m", message]);
    },
  };
}

/**
 * A scenario's own copy of the prepared baseline — sources, vendored engine,
 * receipts, and the git history that `--changed` reads.
 *
 * Everything is copied, including `.git` and `.dads`: a scenario that expects a
 * receipt to be reused, removed, or corrupted is only proving anything if the
 * receipt it acts on came from a real run.
 */
export function copyPreparedProject(preparedRoot, scenarioRoot) {
  cpSync(preparedRoot, scenarioRoot, {
    recursive: true,
    verbatimSymlinks: true,
  });
  return scenarioRoot;
}

function findPackageNodeModules(packageSource) {
  let directory = dirname(packageSource);
  while (directory !== dirname(directory)) {
    if (basename(directory) === "node_modules") return directory;
    const workspace = join(directory, "node_modules");
    if (existsSync(workspace)) return workspace;
    directory = dirname(directory);
  }
  throw new Error(`Could not find node_modules beside ${packageSource}.`);
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}
