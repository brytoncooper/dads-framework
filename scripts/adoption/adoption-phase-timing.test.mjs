import assert from "node:assert/strict";
import test from "node:test";

import { createPhaseTimer } from "./adoption-phase-timing.mjs";

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    advance(milliseconds) {
      value += milliseconds;
    },
  };
}

test("serial runs of a phase spend exactly the wall clock they occupy", () => {
  const clock = fakeClock();
  const timer = createPhaseTimer(clock.now);

  for (let run = 0; run < 3; run += 1) {
    const end = timer.start("pack");
    clock.advance(100);
    end();
  }

  assert.deepEqual(timer.report(), [
    { phase: "pack", runs: 3, totalMs: 300, spanMs: 300 },
  ]);
});

test("overlapping runs spend more than the wall clock they occupy", () => {
  const clock = fakeClock();
  const timer = createPhaseTimer(clock.now);

  const first = timer.start("install");
  const second = timer.start("install");
  clock.advance(100);
  first();
  second();

  assert.deepEqual(timer.report(), [
    { phase: "install", runs: 2, totalMs: 200, spanMs: 100 },
  ]);
});

test("phases keep the order they were first opened in", async () => {
  const clock = fakeClock();
  const timer = createPhaseTimer(clock.now);

  await timer.time("pack", () => clock.advance(10));
  await timer.time("install", () => clock.advance(20));
  await timer.time("pack", () => clock.advance(5));

  assert.deepEqual(
    timer.report().map((entry) => entry.phase),
    ["pack", "install"],
  );
});

test("records the phase of a run that threw", async () => {
  const timer = createPhaseTimer(fakeClock().now);

  await assert.rejects(
    () =>
      timer.time("install", () => {
        throw new Error("npm exploded");
      }),
    /npm exploded/,
  );
  assert.equal(timer.report()[0].runs, 1);
});

test("refuses to close a run twice", () => {
  const timer = createPhaseTimer(fakeClock().now);
  const end = timer.start("pack");
  end();

  assert.throws(end, /closed twice/);
});

test("refuses to report while a phase is still running", () => {
  const timer = createPhaseTimer(fakeClock().now);
  timer.start("pack");

  assert.throws(() => timer.report(), /still running/);
});

test("refuses a phase without a name", () => {
  const timer = createPhaseTimer(fakeClock().now);

  assert.throws(() => timer.start(""), /non-empty string/);
});

test("prints a table with a row per phase", () => {
  const clock = fakeClock();
  const timer = createPhaseTimer(clock.now);
  const end = timer.start("pack");
  clock.advance(2500);
  end();

  const table = timer.formatTable("adoption phases");

  assert.equal(table.split("\n")[0], "adoption phases:");
  assert.match(table, /phase\s+runs\s+total s\s+wall s/);
  assert.match(table, /pack\s+1\s+2\.5\s+2\.5/);
});
