/**
 * Clean-consumer phase of the testing package proof: install the two tarballs
 * into an empty project outside this workspace, then prove the library and the
 * installed `dad-test` executable both work there.
 *
 * The environment is scrubbed on every child process, so nothing this
 * repository sets can stand in for something the published package must carry
 * itself. `verify-testing-package.mjs` owns the run; this module owns the
 * consumer.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";

import { readJson, requireFile } from "./verify-testing-package-lib.mjs";

export function installCleanConsumer(
  consumerDirectory,
  facadeTarball,
  nativeTarball,
  nativePackageName,
) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const cleanEnvironment = cleanConsumerEnvironment();
  execFileSync(npm, ["init", "--yes"], {
    cwd: consumerDirectory,
    stdio: "ignore",
    env: cleanEnvironment,
  });
  execFileSync(
    npm,
    [
      "install",
      "--no-save",
      "--no-package-lock",
      "--ignore-scripts",
      "--offline",
      "--omit=optional",
      facadeTarball.path,
      nativeTarball.path,
    ],
    {
      cwd: consumerDirectory,
      stdio: "inherit",
      env: cleanEnvironment,
    },
  );
  const scopeDirectory = join(
    consumerDirectory,
    "node_modules",
    "@dads-framework",
  );
  const installedNativePackages = existsSync(scopeDirectory)
    ? readdirSync(scopeDirectory).filter((entry) =>
        entry.startsWith("testing-native-"),
      )
    : [];
  const expectedDirectory = nativePackageName.replace("@dads-framework/", "");
  if (
    installedNativePackages.length !== 1 ||
    installedNativePackages[0] !== expectedDirectory
  ) {
    throw new Error(
      `Clean consumer installed unexpected native packages: ${installedNativePackages.join(", ") || "none"}.`,
    );
  }
  const consumerRequire = createRequire(
    join(consumerDirectory, "consumer-entry.mjs"),
  );
  let resolvedNativeBinary;
  try {
    resolvedNativeBinary = consumerRequire.resolve(nativePackageName);
  } catch (error) {
    throw new Error(
      `Clean consumer could not resolve ${nativePackageName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const consumerNodeModules = realpathSync(
    resolve(consumerDirectory, "node_modules"),
  );
  const relativeResolvedBinary = relative(
    consumerNodeModules,
    realpathSync(resolvedNativeBinary),
  );
  if (
    !relativeResolvedBinary ||
    relativeResolvedBinary.startsWith("..") ||
    isAbsolute(relativeResolvedBinary)
  ) {
    throw new Error(
      `Clean consumer resolved ${nativePackageName} outside its node_modules: ${resolvedNativeBinary}`,
    );
  }
}

export function runCleanConsumerPlan(consumerDirectory) {
  writeFileSync(
    join(consumerDirectory, "dads.testing.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        workspace: { root: ".", fullFallback: { taskIds: ["consumer:test"] } },
        projects: [{ id: "consumer", root: ".", fallbackDependencies: [] }],
        tasks: [
          {
            id: "consumer:test",
            project: "consumer",
            kind: "test",
            execution: { executable: "node", args: ["--version"], cwd: "." },
            dependsOn: [],
            impact: { mode: "always" },
          },
        ],
      },
      null,
      2,
    ),
  );
  execFileSync("git", ["init", "-q"], {
    cwd: consumerDirectory,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    ["config", "user.email", "dads-testing-proof@example.invalid"],
    { cwd: consumerDirectory, stdio: "ignore" },
  );
  execFileSync("git", ["config", "user.name", "Dads Testing Proof"], {
    cwd: consumerDirectory,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "dads.testing.json"], {
    cwd: consumerDirectory,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "-qm", "baseline"], {
    cwd: consumerDirectory,
    stdio: "ignore",
  });
  mkdirSync(join(consumerDirectory, "src"), { recursive: true });
  writeFileSync(join(consumerDirectory, "src", "changed.js"), "export {};\n");

  const source = [
    'import { planTesting } from "@dads-framework/testing";',
    "const plan = await planTesting({ workspaceRoot: process.cwd() });",
    'if (plan.tasks.length !== 1 || plan.tasks[0]?.id !== "consumer:test" || plan.tasks[0]?.decision !== "run") throw new Error("Clean consumer plan did not select its changed task.");',
  ].join(" ");
  execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: consumerDirectory,
    stdio: "inherit",
    env: cleanConsumerEnvironment(),
  });
}

/**
 * Proves the installed `dad-test` executable — not just the library — works in a
 * clean consumer: it explains a plan, writes a report, and generates a manifest
 * for a workspace package it discovers itself.
 */
export function runCleanConsumerCli(consumerDirectory) {
  const cliPath = join(
    consumerDirectory,
    "node_modules",
    "@dads-framework",
    "testing",
    "bin",
    "dad-test.js",
  );
  requireFile(cliPath, "installed dad-test CLI");

  const explained = runConsumerCli(consumerDirectory, cliPath, [
    "explain",
    "--all",
    "--json",
  ]);
  if (
    explained.result.tasks?.[0]?.id !== "consumer:test" ||
    explained.result.summary?.selected !== 1
  ) {
    throw new Error(
      describeConsumerCli(explained, "did not explain the one consumer task"),
    );
  }

  const planned = runConsumerCli(consumerDirectory, cliPath, [
    "plan",
    "--all",
    "--report",
    "report.json",
    "--json",
  ]);
  if (!existsSync(join(consumerDirectory, "report.json"))) {
    throw new Error(describeConsumerCli(planned, "did not write report.json"));
  }
  if (planned.result.report?.projectClosure?.closureTaskCount !== 1) {
    throw new Error(
      describeConsumerCli(planned, "reported an unexpected project closure"),
    );
  }

  writeConsumerWorkspacePackage(consumerDirectory);

  const initialized = runConsumerCli(consumerDirectory, cliPath, [
    "init",
    "--force",
    "--json",
  ]);
  const generatedTaskIds = (initialized.result.manifest?.tasks ?? []).map(
    (task) => task?.id,
  );
  if (!generatedTaskIds.includes("lib:test")) {
    throw new Error(
      describeConsumerCli(
        initialized,
        "did not generate a lib:test task for the workspace package",
      ),
    );
  }
  if (initialized.result.report?.validation?.method !== "native") {
    throw new Error(
      describeConsumerCli(
        initialized,
        "did not validate the generated manifest with the native engine",
      ),
    );
  }
}

export function runCleanConsumerNx(consumerDirectory) {
  const source = [
    'import assert from "node:assert/strict";',
    'import { importNxTestingWorkspace, planNativeNxTesting } from "@dads-framework/testing/nx";',
    "assert.equal(typeof importNxTestingWorkspace, 'function');",
    "assert.equal(typeof planNativeNxTesting, 'function');",
  ].join(" ");
  execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: consumerDirectory,
    stdio: "inherit",
    env: cleanConsumerEnvironment(),
  });

  const bins = new Map([
    ["dad-test-import-nx", 2],
    ["dad-test-nx", 1],
  ]);
  for (const [name, expectedStatus] of bins) {
    const executable = process.platform === "win32" ? `${name}.cmd` : name;
    requireFile(
      join(consumerDirectory, "node_modules", ".bin", executable),
      `installed ${name} executable`,
    );
    const completed = spawnSync(
      process.execPath,
      [
        join(
          consumerDirectory,
          "node_modules",
          "@dads-framework",
          "testing",
          "bin",
          `${name}.js`,
        ),
      ],
      {
        cwd: consumerDirectory,
        encoding: "utf8",
        env: cleanConsumerEnvironment(),
      },
    );
    if (
      completed.status !== expectedStatus ||
      !completed.stderr?.startsWith(`Usage: ${name} `)
    ) {
      throw new Error(
        `Unexpected packed ${name} response: ${completed.stderr}`,
      );
    }
  }
}

/** Adds one npm workspace package so `init` has a package to discover. */
function writeConsumerWorkspacePackage(consumerDirectory) {
  mkdirSync(join(consumerDirectory, "packages", "lib"), { recursive: true });
  writeFileSync(
    join(consumerDirectory, "packages", "lib", "package.json"),
    `${JSON.stringify(
      { name: "lib", private: true, scripts: { test: "node --version" } },
      null,
      2,
    )}\n`,
  );
  const consumerManifestPath = join(consumerDirectory, "package.json");
  const consumerManifest = readJson(consumerManifestPath);
  consumerManifest.workspaces = ["packages/*"];
  writeFileSync(
    consumerManifestPath,
    `${JSON.stringify(consumerManifest, null, 2)}\n`,
  );
}

function runConsumerCli(consumerDirectory, cliPath, commandArguments) {
  const completed = spawnSync(
    process.execPath,
    [cliPath, ...commandArguments],
    {
      cwd: consumerDirectory,
      encoding: "utf8",
      env: cleanConsumerEnvironment(),
    },
  );
  const invocation = {
    label: `dad-test ${commandArguments.join(" ")}`,
    stdout: completed.stdout ?? "",
    stderr: completed.stderr ?? "",
    result: undefined,
  };
  if (completed.error) {
    throw new Error(
      describeConsumerCli(
        invocation,
        `could not be spawned: ${completed.error.message}`,
      ),
      { cause: completed.error },
    );
  }
  if (completed.status !== 0) {
    throw new Error(
      describeConsumerCli(
        invocation,
        `exited ${String(completed.status)} instead of 0`,
      ),
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(invocation.stdout);
  } catch (error) {
    throw new Error(describeConsumerCli(invocation, "did not return JSON"), {
      cause: error,
    });
  }
  if (parsed?.ok !== true || parsed.result === undefined) {
    throw new Error(
      describeConsumerCli(invocation, "returned a failure envelope"),
    );
  }
  invocation.result = parsed.result;
  return invocation;
}

function describeConsumerCli(invocation, problem) {
  return `Clean consumer ${invocation.label} ${problem}. stdout: ${invocation.stdout.slice(0, 500)} stderr: ${invocation.stderr.slice(0, 500)}`;
}

function cleanConsumerEnvironment() {
  const environment = { ...process.env };
  delete environment["DADS_TEST_NATIVE_BINARY"];
  delete environment["NODE_PATH"];
  delete environment["NODE_OPTIONS"];
  return environment;
}
