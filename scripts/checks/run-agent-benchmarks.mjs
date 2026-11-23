/* global process */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const benchmark = JSON.parse(readFileSync(join(root, ".agents/benchmarks/http-agent-tasks.json"), "utf8"));

const results = benchmark.tasks.map((task) => {
  const completed = spawnSync(
    process.execPath,
    ["packages/foundation/toolbox/dist/cli.js", "orient", task.path, "--json"],
    { cwd: root, encoding: "utf8" },
  );
  if (completed.status !== 0) {
    throw new Error(`${task.name} failed to orient: ${completed.stderr.trim()}`);
  }
  const response = JSON.parse(completed.stdout);
  const packageMatches = response.orientation.packageName === task.expectedPackage;
  const outputFits = completed.stdout.length <= task.maxOutputCharacters;
  if (!packageMatches || !outputFits) {
    throw new Error(
      `${task.name} failed: expected ${task.expectedPackage}, received ${response.orientation.packageName}, output characters ${completed.stdout.length}/${task.maxOutputCharacters}.`,
    );
  }
  return {
    name: task.name,
    packageName: response.orientation.packageName,
    outputCharacters: completed.stdout.length,
  };
});

process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`);
