import assert from "node:assert/strict";
import test from "node:test";
import { soundnessInvocation } from "./testing-soundness-invocation.mjs";

test("soundness uses the workspace builder and local report when no paths are explicit", () => {
  assert.deepEqual(
    soundnessInvocation(["--shard", "1/3"], () => "/built/dad-test"),
    [
      "--shard",
      "1/3",
      "--dad-test",
      "/built/dad-test",
      "--output",
      "target/soundness-local.json",
    ],
  );
});

test("soundness preserves supplied workflow options without invoking a second build", () => {
  const supplied = [
    "--dad-test",
    "target/debug/dad-test",
    "--output",
    "soundness-1.json",
    "--shard",
    "1/3",
  ];
  const unexpectedBuild = () => {
    throw new Error("explicit engine triggered a build");
  };
  assert.deepEqual(soundnessInvocation(supplied, unexpectedBuild), supplied);
  assert.throws(
    () => soundnessInvocation(["--output"], unexpectedBuild),
    /requires a value/u,
  );
});
