/**
 * The signal contract: one question, one number per key, and the sentence Dad
 * answers with when somebody argues with the number.
 *
 * A signal is the measure contract a source-budget ratchet already defines —
 * a name, a direction, a threshold, a map from key to count — plus the two
 * things that make a verdict arguable rather than obeyed: the issue it
 * evidences, and a line of `DAD.md` that says what the rule is for. A signal
 * with no sentence cannot be written down, because the type requires one; a
 * signal with no fixture cannot be merged, because the corpus test requires
 * one. Those two guards are the whole defence against a rule nobody can
 * explain.
 *
 * A threshold is per profile, and `null` means report-only in that profile.
 * There is no third state: a signal either has a number to be judged against
 * or it says it has none.
 */

import type { DoctorContext } from "./doctor-context.js";
import type { DaddyIssueId } from "./issues.js";

/** The two postures a project may adopt. It may tighten, never loosen. */
export type DoctorProfile = "standard" | "strict";

/** The input a signal needs, which decides the order signals run in. */
export type SignalInput = "text" | "typescript" | "packages" | "routes" | "git" | "online";

/** What the number counts, printed beside the threshold. */
export type SignalUnit = "count" | "lines" | "files" | "days" | "percent";

/** Whether the number may never grow or may never shrink. */
export type SignalDirection = "ceiling" | "floor";

/** Where a reader goes to see the reading for themselves. */
export type SignalEvidence = {
  readonly path: string;
  readonly line?: number;
  readonly name?: string;
};

/** One key's number, with the places that number came from. */
export type SignalReading = {
  readonly value: number;
  readonly evidence: readonly SignalEvidence[];
};

/** The threshold each profile applies; `null` is report-only. */
export type SignalThresholds = {
  readonly standard: number | null;
  readonly strict: number | null;
};

export type SignalReadings = ReadonlyMap<string, SignalReading>;

export type DoctorSignal = {
  /** Stable id, the one the companion writes in parentheses. */
  readonly id: string;
  /** The issue this signal evidences, and the heading it is reported under. */
  readonly issue: DaddyIssueId;
  /**
   * Issues this signal also evidences. It is measured once and shown under
   * each of them, so a copied type counts against anxious attachment and
   * against the paper wall without being counted twice.
   */
  readonly alsoUnder?: readonly DaddyIssueId[];
  /** One line, from the companion's numbered test. */
  readonly question: string;
  readonly reads: SignalInput;
  readonly unit: SignalUnit;
  readonly direction: SignalDirection;
  readonly thresholds: SignalThresholds;
  /** The `DAD.md` line that says what the rule is for. */
  readonly sentence: string;
  /**
   * The source-budget measure this signal reproduces. The parity test pairs
   * them by this name and fails on any key or value they disagree about; the
   * measure is deleted once the doctor gates.
   */
  readonly measure?: string;
  /**
   * True for a signal `dad doctor` reports but the gate never judges. A floor
   * on a count that falls whenever code is deleted (tests, doctor cases)
   * blocked healthy deletions, so those are shown, not held.
   */
  readonly reportOnly?: true;
  run(context: DoctorContext): Promise<SignalReadings>;
};

/** A reading with no places to point at, which is the common case. */
export function countedReading(value: number): SignalReading {
  return { value, evidence: [] };
}

/** A reading whose evidence is the file the number was counted in. */
export function fileReading(path: string, value: number): SignalReading {
  return { value, evidence: [{ path }] };
}

/**
 * Whether a signal evidences an issue: it owns the issue, or it is cross-listed
 * under it. One answer for both readers — the report, which shows the signal
 * under every issue it evidences, and `--issue`, which selects it under any of
 * them.
 */
export function signalEvidences(signal: DoctorSignal, issue: DaddyIssueId): boolean {
  return signal.issue === issue || (signal.alsoUnder ?? []).includes(issue);
}

/** The threshold a profile applies, or `null` when the signal is report-only. */
export function thresholdFor(signal: DoctorSignal, profile: DoctorProfile): number | null {
  return profile === "strict" ? signal.thresholds.strict : signal.thresholds.standard;
}
