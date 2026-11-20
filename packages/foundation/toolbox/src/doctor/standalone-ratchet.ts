import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runDoctorGate, type GateResult } from "./doctor-gate.js";
import { serializeBaseline } from "./doctor-gate-baseline.js";
import { BASELINE_PATH, type GateMode } from "./doctor-gate-model.js";
import {
  RATCHET_POLICY_PATH,
  ratchetSignals,
  readRatchetPolicy,
  requireStandaloneRepository,
  serializeRatchetPolicy,
} from "./standalone-ratchet-policy.js";
import { requireGitWorkspace } from "./signals/scanners/git-history.js";
import { protectAdoptedBase } from "./standalone-ratchet-base.js";

type InitRatchet = {
  readonly root: string;
  readonly reason: string;
  readonly today: string;
};

export async function initializeStandaloneRatchet(
  input: InitRatchet,
): Promise<GateResult> {
  requireStandaloneRepository(input.root);
  requireGitWorkspace(input.root);
  if (!input.reason.trim())
    throw new Error("Provide a reason for the initial exceptions.");
  const baselinePath = join(input.root, BASELINE_PATH);
  if (existsSync(baselinePath)) {
    throw new Error(
      `${BASELINE_PATH} already exists. Use dad doctor --update after improving the code.`,
    );
  }
  const policy = readRatchetPolicy(input.root);
  const result = await runDoctorGate({
    root: input.root,
    signals: ratchetSignals(policy ?? new Map()),
    mode: {
      json: false,
      update: false,
      seed: true,
      report: false,
      profile: "strict",
      files: undefined,
      base: undefined,
      today: input.today,
      reason: input.reason,
      key: undefined,
    },
    write: () => {},
  });
  requireMeasurements(result);
  if (result.exitCode !== 0) return result;
  mkdirSync(dirname(baselinePath), { recursive: true });
  if (policy === undefined) {
    writeFileSync(
      join(input.root, RATCHET_POLICY_PATH),
      serializeRatchetPolicy(new Map()),
      { flag: "wx" },
    );
  }
  writeFileSync(baselinePath, serializeBaseline(result.baseline), {
    flag: "wx",
  });
  return result;
}

type AdoptedGate = {
  readonly root: string;
  readonly mode: GateMode;
  readonly narrowed: boolean;
};

export async function runStandaloneRatchet(
  input: AdoptedGate,
): Promise<GateResult | undefined> {
  const { root, mode } = input;
  const policy = readRatchetPolicy(root);
  if (mode.base !== undefined) protectAdoptedBase(root, mode.base, policy);
  if (policy === undefined) return undefined;
  requireAdoptedGate(input);
  const result = await runDoctorGate({
    root,
    mode: { ...mode, profile: "strict", base: undefined },
    signals: ratchetSignals(policy),
    ...(mode.update ? { write: () => {} } : {}),
  });
  requireMeasurements(result);
  if (mode.update && result.wrote) {
    writeFileSync(
      join(root, BASELINE_PATH),
      serializeBaseline(result.baseline),
    );
  }
  return result;
}

function requireAdoptedGate({ narrowed, mode, root }: AdoptedGate): void {
  requireGitWorkspace(root);
  if (narrowed)
    throw new Error(
      "The standalone ratchet runs its whole code-health profile.",
    );
  if (mode.seed)
    throw new Error(
      "The standalone ratchet records exceptions only during dad baseline init.",
    );
  if (!existsSync(join(root, BASELINE_PATH))) {
    throw new Error(
      `${BASELINE_PATH} is missing. Run dad baseline init for a new adoption.`,
    );
  }
}

function requireMeasurements(result: GateResult): void {
  const missed = result.findings.filter(
    (finding) =>
      finding.key === "" && finding.message.startsWith("not measured"),
  );
  if (missed.length > 0) {
    throw new Error(
      missed
        .map((finding) => `${finding.measure}: ${finding.message}`)
        .join("\n"),
    );
  }
}
