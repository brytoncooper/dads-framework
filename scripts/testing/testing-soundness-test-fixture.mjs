import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const runner = resolve(
  process.env.DADS_SOUNDNESS_TEST_RUNNER ??
    "scripts/testing/testing-soundness.mjs",
);

export function runFixture(fixture, failBaseline = false, options = {}) {
  const output = join(fixture.root, "evidence.json");
  const result = spawnSync(
    process.execPath,
    [
      ...(options.nodeArguments ?? []),
      runner,
      ...(options.caseJobs === undefined
        ? []
        : ["--case-jobs", options.caseJobs]),
      "--fixture",
      fixture.root,
      "--dad-test",
      fixture.native,
      "--output",
      output,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...(options.env ?? {}),
        DADS_TEST_FAIL_BASELINE: failBaseline ? "1" : "0",
      },
    },
  );
  return { result, evidence: JSON.parse(readFileSync(output, "utf8")) };
}

export function events(fixture) {
  return readFileSync(fixture.log, "utf8").trim().split("\n");
}

export function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "dads-baseline-regression-"));
  const baseline = join(root, "baseline");
  const log = join(root, "events.log");
  const native = join(root, "native.cjs");
  mkdirSync(baseline);
  writeFileSync(join(baseline, ".gitignore"), "/node_modules\n/artifact\n");
  writeFileSync(join(baseline, "input.txt"), "pristine");
  const common = `const fs = require('node:fs');
const mode = fs.existsSync('marker.txt') ? fs.readFileSync('marker.txt', 'utf8') : 'baseline';
if (fs.existsSync('artifact') || fs.readFileSync('input.txt', 'utf8') !== 'pristine') process.exit(99);
if (process.env.DADS_TEST_ASSERT_LIMITS === '1' && process.env.VITEST_MAX_WORKERS !== '1') process.exit(96);
`;
  writeFileSync(
    join(baseline, "task.cjs"),
    `${common}
fs.appendFileSync(${JSON.stringify(log)}, mode + '\\n');
fs.writeFileSync('artifact', 'must never reach another workspace');
// Change the live fixture after freezing to prove later cases use the snapshot.
if (mode === 'baseline') fs.writeFileSync(${JSON.stringify(join(baseline, "input.txt"))}, 'changed live source');
process.exit(mode === 'baseline' && process.env.DADS_TEST_FAIL_BASELINE !== '1' ? 0 : 1);
`,
  );
  writeFileSync(
    native,
    `#!${process.execPath}
${common}
fs.appendFileSync(${JSON.stringify(log)}, 'native:' + mode + '\\n');
let input = ''; process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  if (process.env.DADS_TEST_ASSERT_LIMITS === '1' && request.jobs !== 1) process.exit(95);
  const actualBase = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD^'], {encoding: 'utf8'}).trim();
  if (request.base !== actualBase) process.exit(98);
  process.stdout.write(JSON.stringify({ok: true, result: {
    plan: {scope: {changedPaths: ['marker.txt'], fullFallback: false}, tasks: [{id: 'fixture:test', decision: 'run', reason: 'changed-path', confidence: 'proven', causes: []}], issues: [], complete: true},
    run: {tasks: [{id: 'fixture:test', status: 'failed', exitCode: 1}], counts: {executed: 1, failed: 1, blocked: 0, notApplicable: 0}, exitCode: 1}
  }}));
});
`,
  );
  chmodSync(native, 0o755);
  writeFileSync(
    join(root, "dads.testing.json"),
    JSON.stringify({
      tasks: [
        {
          id: "fixture:test",
          dependsOn: [],
          execution: { executable: process.execPath, args: ["task.cjs"] },
        },
      ],
    }),
  );
  writeFileSync(
    join(root, "cases.json"),
    JSON.stringify({
      allTaskIds: ["fixture:test"],
      cases: ["alpha", "beta"].map((id) => ({
        id,
        description: id,
        classification: "breaking",
        fullFallbackPolicy: "forbidden",
        requiredTaskIds: ["fixture:test"],
        expectedSelectionTaskIds: ["fixture:test"],
        expectedChangedTaskIds: ["fixture:test"],
        operations: [{ kind: "write", path: "marker.txt", contents: id }],
      })),
    }),
  );
  return { root, baseline, log, native };
}
