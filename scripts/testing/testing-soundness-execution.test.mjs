import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  assertObservedTasks,
  assertValidBaseline,
  compareTaskOutcomes,
  executeTasksIndependently,
  loadTaskManifest,
  taskGraphWidth,
} from "./testing-soundness-execution.mjs";

const chains = [
  { id: "core:lint", dependsOn: [] },
  { id: "core:typecheck", dependsOn: ["core:lint"] },
  { id: "core:test", dependsOn: ["core:typecheck"] },
  { id: "api:lint", dependsOn: [] },
  { id: "api:typecheck", dependsOn: ["core:test", "api:lint"] },
  { id: "api:test", dependsOn: ["api:typecheck"] },
  { id: "web:lint", dependsOn: [] },
  { id: "web:typecheck", dependsOn: ["core:test", "web:lint"] },
  { id: "web:test", dependsOn: ["web:typecheck"] },
];

test("compares normalized outcomes without volatile diagnostics", () => {
  const result = compareTaskOutcomes(
    [
      { id: "api:test", status: "passed", exitCode: 0 },
      { id: "core:test", status: "passed", exitCode: 0 },
    ],
    [
      { id: "api:test", status: "failed", exitCode: 1 },
      { id: "core:test", status: "passed", exitCode: 0 },
    ],
  );
  assert.deepEqual(result.changedTaskIds, ["api:test"]);
});

test("rejects incomplete or invalid task observations", () => {
  const tasks = [{ id: "api:test" }, { id: "core:test" }];
  assert.throws(() => assertObservedTasks(tasks, [{ id: "api:test", status: "passed" }], "Mutation"));
  assert.throws(() =>
    assertObservedTasks(
      tasks,
      [
        { id: "api:test", status: "passed" },
        { id: "core:test", status: "timed-out" },
      ],
      "Mutation",
    ),
  );
  assert.throws(() => assertValidBaseline([{ id: "api:test", status: "failed", exitCode: 1 }]));
});

test("graph width counts the widest set of tasks that can be in flight", () => {
  assert.equal(taskGraphWidth(chains), 3);
  assert.equal(taskGraphWidth([{ id: "only", dependsOn: [] }]), 1);
  assert.equal(
    taskGraphWidth([
      { id: "first", dependsOn: [] },
      { id: "second", dependsOn: ["first"] },
    ]),
    1,
  );
});

test("an unrunnable task graph is refused, not scheduled", () => {
  assert.throws(() => taskGraphWidth([{ id: "orphan", dependsOn: ["absent"] }]), /unknown task absent/);
  assert.throws(
    () =>
      taskGraphWidth([
        { id: "left", dependsOn: ["right"] },
        { id: "right", dependsOn: ["left"] },
      ]),
    /dependency cycle/,
  );
});

test("independent tasks overlap while dependents wait for their prerequisites", async () => {
  const directory = mkdtempSync(join(tmpdir(), "soundness-schedule-"));
  try {
    const tasks = [
      recordingTask("first", "second"),
      recordingTask("second", "first"),
      { ...recordingTask("last", null), dependsOn: ["first"] },
    ];
    const outcomes = await executeTasksIndependently(tasks, directory, {}, 2);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.id),
      ["first", "second", "last"],
    );
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["passed", "passed", "passed"],
    );
    const events = readEvents(directory);
    assert.deepEqual(events.slice(0, 2).sort(), ["start first", "start second"]);
    assert.ok(events.indexOf("end first") < events.indexOf("start last"));
    assert.equal(events.length, 6);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("one task job runs the same tasks strictly one at a time", async () => {
  const directory = mkdtempSync(join(tmpdir(), "soundness-serial-"));
  try {
    const tasks = ["first", "second", "third"].map((id) => recordingTask(id, null));
    const outcomes = await executeTasksIndependently(tasks, directory, {}, 1);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["passed", "passed", "passed"],
    );
    assert.deepEqual(readEvents(directory), [
      "start first",
      "end first",
      "start second",
      "end second",
      "start third",
      "end third",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects an invalid task job limit", async () => {
  for (const taskJobs of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(
      executeTasksIndependently([{ id: "only", dependsOn: [] }], tmpdir(), {}, taskJobs),
      /positive safe integer/,
    );
  }
});

test("rejects duplicate task declarations", () => {
  const directory = mkdtempSync(join(tmpdir(), "soundness-manifest-"));
  const manifest = join(directory, "dads.testing.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      tasks: [
        {
          id: "fixture:test",
          execution: { executable: "node", args: [] },
          dependsOn: [],
        },
        {
          id: "fixture:test",
          execution: { executable: "node", args: [] },
          dependsOn: [],
        },
      ],
    }),
  );
  try {
    assert.throws(() => loadTaskManifest(manifest));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A task that records when it starts and ends. Given a `peer` it also waits
 * for that peer to start, so the pair can only both finish when the scheduler
 * actually ran them at the same time.
 */
function recordingTask(id, peer) {
  const wait =
    peer === null
      ? ""
      : `const deadline = Date.now() + 5000;
while (!fs.existsSync('${peer}.started')) {
  if (Date.now() > deadline) process.exit(97);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}`;
  return {
    id,
    dependsOn: [],
    execution: {
      executable: process.execPath,
      args: [
        "-e",
        `const fs = require('node:fs');
fs.appendFileSync('events.log', 'start ${id}\\n');
fs.writeFileSync('${id}.started', '');
${wait}
fs.appendFileSync('events.log', 'end ${id}\\n');`,
      ],
    },
  };
}

function readEvents(directory) {
  return readFileSync(join(directory, "events.log"), "utf8").trim().split("\n");
}
