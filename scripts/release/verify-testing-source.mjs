import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TSC = "node_modules/typescript-native/bin/tsc";
const VITEST = "node_modules/vitest/vitest.mjs";
const ESLINT = "node_modules/eslint/bin/eslint.js";
const PRETTIER = "node_modules/prettier/bin/prettier.cjs";

function discoverTests(root, directory) {
  return readdirSync(join(root, directory))
    .filter((entry) => entry.endsWith(".test.mjs"))
    .sort()
    .map((entry) => `${directory}/${entry}`);
}

export function testingSourceSteps(root = REPOSITORY_ROOT, env = process.env) {
  const scriptTests = [...discoverTests(root, "scripts/testing"), ...discoverTests(root, "scripts/release")];
  const vitestArgs = [VITEST, "run"];
  const maxWorkers = env.VITEST_MAX_WORKERS?.trim();
  if (maxWorkers !== undefined && maxWorkers.length > 0) {
    vitestArgs.push(`--maxWorkers=${maxWorkers}`);
  }
  vitestArgs.push("packages/testing/core/", "fixtures/testing/");

  return [
    {
      id: "sync-licenses",
      args: ["scripts/release/sync-package-licenses.mjs"],
    },
    {
      id: "build",
      args: [TSC, "-b", "--pretty", "false"],
    },
    {
      id: "format",
      args: [
        PRETTIER,
        "--check",
        "packages/testing/core/",
        "fixtures/testing/",
        "scripts/testing/",
        "scripts/release/",
      ],
    },
    {
      id: "vitest-testing",
      args: vitestArgs,
    },
    {
      id: "test-types",
      args: ["scripts/checks/check-test-types.mjs"],
    },
    {
      id: "eslint-testing",
      args: [ESLINT, "packages/testing/core/", "fixtures/testing/", "scripts/testing/", "scripts/release/"],
    },
    {
      id: "docs",
      args: ["scripts/checks/check-docs.mjs"],
    },
    {
      id: "invariants",
      args: ["scripts/checks/check-invariants.mjs"],
    },
    {
      id: "dependency-boundaries",
      args: ["scripts/checks/check-dependency-boundaries.mjs"],
    },
    {
      id: "private-references",
      args: ["scripts/checks/check-private-references.mjs"],
    },
    {
      id: "api-report",
      args: ["scripts/checks/generate-api-report.mjs", "--check"],
    },
    {
      id: "markdown-links",
      args: ["scripts/checks/check-markdown-links.mjs"],
    },
    {
      id: "script-tests",
      args: ["--test", ...scriptTests],
    },
  ];
}

export function runTestingSourceVerification(root = REPOSITORY_ROOT, env = process.env) {
  const steps = testingSourceSteps(root, env);
  const startedAt = Date.now();
  for (const step of steps) {
    const stepStart = Date.now();
    process.stdout.write(`verify-testing-source: ${step.id}\n`);
    const result = spawnSync(process.execPath, step.args, {
      cwd: root,
      env,
      stdio: "inherit",
    });
    if (result.error !== undefined) throw result.error;
    const elapsed = ((Date.now() - stepStart) / 1000).toFixed(2);
    if (result.status !== 0) {
      process.stderr.write(`verify-testing-source: ${step.id} failed after ${elapsed}s\n`);
      return result.status ?? 1;
    }
    process.stdout.write(`verify-testing-source: ${step.id} passed (${elapsed}s)\n`);
  }
  const totalElapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  process.stdout.write(`verify-testing-source: all ${String(steps.length)} checks passed (${totalElapsed}s)\n`);
  return 0;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  process.exitCode = runTestingSourceVerification();
}
