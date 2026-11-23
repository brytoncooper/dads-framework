/**
 * The flags that turn the report into a gate, and the rules about combining
 * them.
 *
 * `dad doctor` describes a repository and exits zero. The flags here judge it
 * against `.agents/source-budgets.json` and exit one when something loosened:
 * `--gate` evaluates, `--update` applies every downward move, `--seed` records
 * an exception with a reason and the date, `--report` lists what is recorded
 * and what is over, `--file` measures selected paths, and `--base` compares this
 * baseline against the one at a git ref. `--json` combines with all of them.
 *
 * The exclusivity rules are the ones the source-budget ratchet had, because
 * they are the ones that keep a mode from meaning two things: seeding is not
 * updating, comparing against a ref reads and never writes, and one file is
 * not a repository.
 */

import { runDoctorGate, type GateInput, type GateResult } from "./doctor/doctor-gate.js";
import type { GateMode } from "./doctor/doctor-gate-model.js";
import { signalEvidences, type DoctorProfile } from "./doctor/doctor-signal.js";
import { DOCTOR_SIGNALS } from "./doctor/doctor-signals.js";
import type { DaddyIssue } from "./doctor/issues.js";
import { runStandaloneRatchet } from "./doctor/standalone-ratchet.js";

/** The flags that ask for the gate rather than the report. */
export const GATE_FLAGS = new Set(["--gate", "--update", "--seed", "--report"]);

/** The options that ask for the gate, each of which takes a value. */
export const GATE_OPTIONS = new Set(["--file", "--base"]);

/** The options only the gate reads, which are refused without their mode. */
export const GATE_ONLY_OPTIONS = new Set(["--reason", "--key"]);

export type GateArgumentInput = {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly profile: DoctorProfile;
  readonly today: string | undefined;
};

/**
 * The mode the arguments asked for, or `undefined` when they asked for the
 * report. Every gate flag implies the gate, so `--report` and `--file` do not
 * also need `--gate` written beside them.
 */
export function readGateMode(input: GateArgumentInput): GateMode | undefined {
  const asked =
    [...GATE_FLAGS].some((flag) => input.flags.has(flag)) ||
    [...GATE_OPTIONS].some((option) => input.values.has(option));
  const mode: GateMode = {
    json: input.flags.has("--json"),
    update: input.flags.has("--update"),
    seed: input.flags.has("--seed"),
    report: input.flags.has("--report"),
    profile: input.profile,
    files: input.values.get("--file")?.map((path) => path.replace(/^\.\//, "")),
    base: lastValue(input, "--base"),
    today: input.today,
    reason: lastValue(input, "--reason"),
    key: lastValue(input, "--key"),
  };
  if (!asked) {
    refuseSeedOnlyOptions(mode);
    return undefined;
  }
  refuseConflict(mode);
  return mode;
}

function lastValue(input: GateArgumentInput, option: string): string | undefined {
  return input.values.get(option)?.at(-1);
}

function refuseConflict(mode: GateMode): void {
  refuseExclusiveModes(mode);
  if (mode.seed && mode.today === undefined) {
    throw new Error("--seed needs --today YYYY-MM-DD.");
  }
  refuseSeedOnlyOptions(mode);
}

function refuseExclusiveModes(mode: GateMode): void {
  if (mode.seed && mode.update) {
    throw new Error("--seed and --update are exclusive.");
  }
  if (mode.base !== undefined && (mode.update || mode.seed)) {
    throw new Error("--base only reads; it cannot be combined with --update or --seed.");
  }
  if (mode.files !== undefined && (mode.base !== undefined || mode.seed)) {
    throw new Error("--file cannot be combined with --base or --seed.");
  }
}

function refuseSeedOnlyOptions(mode: GateMode): void {
  if (mode.seed) return;
  if (mode.reason !== undefined) {
    throw new Error("--reason records a seeded entry; it needs --seed.");
  }
  if (mode.key !== undefined) {
    throw new Error("--key names the one key --seed records; it needs --seed.");
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type GateCommand = {
  readonly root: string;
  readonly mode: GateMode;
  /** The issues to judge; every signal any of them evidences is measured. */
  readonly issues: readonly DaddyIssue[];
  readonly issuesNarrowed: boolean;
};

/**
 * Runs the gate and prints what it decided. `--issue` narrows the signals the
 * same way it narrows the report, and a section of the baseline no selected
 * signal owns is left exactly as it is rather than read as stale.
 */
export async function runGateCommand(command: GateCommand): Promise<GateResult> {
  const standalone = await runStandaloneRatchet({
    root: command.root,
    mode: command.mode,
    narrowed: command.issuesNarrowed,
  });
  if (standalone !== undefined) return standalone;
  const input: GateInput = {
    root: command.root,
    mode: command.mode,
    signals: selectedSignals(command),
  };
  return runDoctorGate(input);
}

function selectedSignals(command: GateCommand) {
  if (!command.issuesNarrowed) return DOCTOR_SIGNALS;
  const chosen = command.issues.map((issue) => issue.id);
  return DOCTOR_SIGNALS.filter((signal) => chosen.some((issue) => signalEvidences(signal, issue)));
}
