import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  AdoptionTaskError,
  runAdoptionTasks,
} from "./adoption-task-runner.mjs";

test("returns a result per task when every task passed", async () => {
  const results = await runAdoptionTasks({
    tasks: [
      { name: "first", run: async () => {} },
      { name: "second", run: async () => {} },
    ],
    jobs: 2,
    label: "proof",
  });

  assert.deepEqual(
    results.map((result) => `${result.name}:${result.status}`),
    ["first:ok", "second:ok"],
  );
});

test("reports the failing task's commands and their output", async () => {
  const error = await runAdoptionTasks({
    tasks: [
      {
        name: "fixture schema",
        run: async (transcript) => {
          await transcript.run(process.execPath, [
            "-e",
            'process.stderr.write("declaration missing\\n");process.exit(2);',
          ]);
        },
      },
    ],
    jobs: 1,
    label: "adoption fixtures",
  }).then(
    () => null,
    (thrown) => thrown,
  );

  assert.ok(error instanceof AdoptionTaskError);
  assert.match(error.message, /adoption fixtures failed\./);
  assert.match(error.message, /FAILED adoption fixtures \/ fixture schema/);
  assert.match(error.message, /declaration missing/);
  assert.match(error.message, /exit: status 2/);
  assert.match(
    error.message,
    /First failure in declared order: fixture schema\./,
  );
});

test("prints a shared prerequisite failure once and points the rest at it", async () => {
  const shared = new Error("the packed creator did not install");
  const failWithShared = async () => {
    throw shared;
  };

  const error = await runAdoptionTasks({
    tasks: [
      { name: "standard-api", run: failWithShared },
      { name: "strict-api", run: failWithShared },
    ],
    jobs: 2,
    label: "generated projects",
  }).then(
    () => null,
    (thrown) => thrown,
  );

  assert.equal(
    error.message.match(/the packed creator did not install/g).length,
    1,
  );
  assert.match(
    error.message,
    /FAILED generated projects \/ strict-api\n {2}the same failure reported for generated projects \/ standard-api/,
  );
  assert.match(error.message, /Tasks: 0 ok, 2 failed, 0 skipped\./);
});
