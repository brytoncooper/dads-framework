import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";

const [, , summary, first, second, expectedState = "running"] = process.argv;
const slots = JSON.parse(await readFile(summary, "utf8"));
const left = slots.find((slot) => slot.worktree === first);
const right = slots.find((slot) => slot.worktree === second);
assert.equal(left.state, expectedState);
assert.equal(right.state, expectedState);
assert.ok(
  left.firstPort + left.portCount <= right.firstPort ||
    right.firstPort + right.portCount <= left.firstPort,
);
assert.notEqual(left.fileRoot, right.fileRoot);
assert.notEqual(left.database, right.database);
for (const slot of [left, right]) {
  for (const url of Object.values(slot.urls)) {
    if (expectedState === "stopped") {
      await assert.rejects(
        globalThis.fetch(url, {
          signal: globalThis.AbortSignal.timeout(2_000),
        }),
      );
      continue;
    }
    const result = await globalThis.fetch(url);
    assert.deepEqual(await result.json(), {
      worktree: slot.worktree,
      db: `${slot.database}|2`,
    });
  }
}
