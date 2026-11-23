import { expect, it } from "vitest";
import type { GateMode } from "./doctor-gate-model.js";
import { gatedSignals } from "./doctor-gate.js";
import { migrationsOutOfOrderSignal } from "./signals/disorganized-attachment/migrations-out-of-order.js";
import { filesOverCeilingSignal } from "./signals/enmeshment/files-over-ceiling.js";
import { branchProtectionOffSignal } from "./signals/its-not-you-its-my-boundaries/branch-protection-off.js";

const fullGate: GateMode = {
  json: false,
  update: false,
  seed: false,
  report: false,
  profile: "strict",
  files: undefined,
  base: undefined,
  today: undefined,
  reason: undefined,
  key: undefined,
};

it("leaves migration history and network checks to the full gate", () => {
  const signals = [migrationsOutOfOrderSignal, branchProtectionOffSignal, filesOverCeilingSignal];
  const fileGate = { ...fullGate, files: ["src/a.migration.ts"] };

  expect(gatedSignals(signals, fullGate)).toEqual(signals);
  expect(gatedSignals(signals, fileGate)).toEqual([filesOverCeilingSignal]);
});
