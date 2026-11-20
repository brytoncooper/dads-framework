/**
 * The report: one verdict per issue, one line per signal, and the sentence the
 * verdict is answerable with.
 *
 * Three verdicts and no fourth. An issue is `present` when a signal with a
 * threshold is over it, `partial` when a signal the strict profile judges saw
 * something this profile only reports, and `absent` otherwise. Nothing is ever
 * at warn: a signal either has a number to be judged against in this profile,
 * or its line says it has none.
 *
 * A signal that is report-only in both profiles is information, not evidence.
 * `blast-radius` says how far one change reaches; no count of reached packages
 * is an illness, so no reading of it can make an issue partial. Only a signal
 * that is report-only in `standard` and judged in `strict` is evidence: Dad
 * has already said what the number should be, and has only declined to hold
 * this profile to it yet.
 *
 * A floor is the same, and it is not a verdict. Its judge is the recorded
 * baseline, which the gate reads; until then a floor prints its number, says
 * `report`, and moves no verdict — a package with 439 error-level lint rules
 * is not partially ill.
 *
 * A signal that ran and found nothing is not a signal that did not run. Only a
 * failure is `not measured`; an empty map is `0 seen`, at the state the reading
 * earned — `ok` under a threshold, `report` without one.
 *
 * Every line carries the number, the threshold, where the threshold came from,
 * and the state, because a verdict a reader cannot check is one they will
 * route around.
 */

import {
  signalEvidences,
  thresholdFor,
  type DoctorProfile,
  type DoctorSignal,
  type SignalDirection,
  type SignalEvidence,
  type SignalInput,
  type SignalUnit,
} from "./doctor-signal.js";
import type { SignalOutcome } from "./doctor-signals.js";
import type { DaddyIssue, DaddyIssueId } from "./issues.js";

const ISSUE_WIDTH = 62;
const SIGNAL_WIDTH = 34;
const AMOUNT_WIDTH = 24;
const SOURCE_WIDTH = 24;
const SENTENCE_WIDTH = 74;

export type IssueVerdict = "present" | "partial" | "absent";
export type SignalState = "over" | "ok" | "report" | "not measured";

export type ReportedReading = {
  readonly key: string;
  readonly value: number;
  readonly evidence: readonly SignalEvidence[];
};

export type ReportedSignal = {
  readonly id: string;
  readonly question: string;
  readonly reads: SignalInput;
  readonly unit: SignalUnit;
  readonly direction: SignalDirection;
  readonly measure: string | null;
  readonly threshold: number | null;
  readonly thresholdSource: string;
  /**
   * Whether the strict profile holds this signal to a number. A signal no
   * profile judges is information, and information moves no verdict.
   */
  readonly judgedInStrict: boolean;
  readonly state: SignalState;
  readonly measured: number;
  readonly over: number;
  readonly total: number;
  readonly sentence: string;
  readonly failure: string | undefined;
  /** What the signal said about how it answered, printed under its line. */
  readonly notes: readonly string[];
  readonly readings: readonly ReportedReading[];
};

export type ReportedIssue = {
  readonly id: DaddyIssueId;
  readonly title: string;
  readonly anchor: string;
  readonly sentence: string;
  readonly verdict: IssueVerdict;
  readonly signals: readonly ReportedSignal[];
};

export type DoctorReport = {
  readonly ok: true;
  readonly root: string;
  readonly profile: DoctorProfile;
  /** The date `--today` supplied, or `null`. Nothing here asks a clock. */
  readonly today: string | null;
  readonly issues: readonly ReportedIssue[];
};

// ---------------------------------------------------------------------------
// Building the report
// ---------------------------------------------------------------------------

export type DoctorReportInput = {
  readonly root: string;
  readonly profile: DoctorProfile;
  readonly today: string | undefined;
  readonly outcomes: readonly SignalOutcome[];
  readonly issues: readonly DaddyIssue[];
};

/**
 * Groups the outcomes under their issues, in `DAD.md` order. A cross-listed
 * signal is measured once and reported under every issue it evidences, so each
 * issue's verdict sees it; the reading is the same object everywhere it
 * appears.
 */
export function buildDoctorReport(input: DoctorReportInput): DoctorReport {
  const issues = input.issues.map((issue) => {
    const signals = input.outcomes
      .filter((outcome) => signalEvidences(outcome.signal, issue.id))
      .map((outcome) => reportSignal(outcome, input.profile));
    return {
      id: issue.id,
      title: issue.title,
      anchor: issue.anchor,
      sentence: issue.sentence,
      verdict: verdictOf(signals),
      signals,
    };
  });
  return {
    ok: true,
    root: input.root,
    profile: input.profile,
    today: input.today ?? null,
    issues,
  };
}

function reportSignal(
  outcome: SignalOutcome,
  profile: DoctorProfile,
): ReportedSignal {
  const signal = outcome.signal;
  const threshold = thresholdFor(signal, profile);
  const values = [...outcome.readings.values()].map((reading) => reading.value);
  const over =
    threshold === null
      ? values.filter((value) => value > 0).length
      : values.filter((value) => value > threshold).length;
  return {
    id: signal.id,
    question: signal.question,
    reads: signal.reads,
    unit: signal.unit,
    direction: signal.direction,
    measure: signal.measure ?? null,
    threshold,
    thresholdSource: describeThreshold(signal, profile),
    judgedInStrict: signal.thresholds.strict !== null,
    state: stateOf(outcome, signal.direction, threshold, over),
    measured: outcome.readings.size,
    over,
    total: values.reduce((sum, value) => sum + value, 0),
    sentence: signal.sentence,
    failure: outcome.failure,
    notes: outcome.notes ?? [],
    readings: selectReadings(outcome, threshold),
  };
}

/**
 * A thresholded ceiling reports the keys that are over it; everything else
 * reports every key it read, because that is the whole of what it found.
 */
function selectReadings(
  outcome: SignalOutcome,
  threshold: number | null,
): readonly ReportedReading[] {
  const reported: ReportedReading[] = [];
  for (const [key, reading] of outcome.readings) {
    if (threshold !== null && reading.value <= threshold) continue;
    reported.push({ key, value: reading.value, evidence: reading.evidence });
  }
  return reported;
}

function stateOf(
  outcome: SignalOutcome,
  direction: SignalDirection,
  threshold: number | null,
  over: number,
): SignalState {
  if (outcome.failure !== undefined) return "not measured";
  if (direction === "floor" || threshold === null) return "report";
  return over > 0 ? "over" : "ok";
}

function describeThreshold(
  signal: DoctorSignal,
  profile: DoctorProfile,
): string {
  if (signal.direction === "floor") return "Dad: floor";
  const threshold = thresholdFor(signal, profile);
  if (threshold === null) return "Dad: report-only";
  const amount =
    signal.unit === "count" ? `${threshold}` : `${threshold} ${signal.unit}`;
  const tightened =
    profile === "strict" &&
    signal.thresholds.strict !== signal.thresholds.standard;
  return tightened ? `Dad: ${amount}; strict` : `Dad: ${amount}`;
}

function verdictOf(signals: readonly ReportedSignal[]): IssueVerdict {
  if (signals.some((signal) => signal.state === "over")) return "present";
  const seen = signals.some(
    (signal) =>
      signal.direction === "ceiling" &&
      signal.threshold === null &&
      signal.judgedInStrict &&
      signal.over > 0,
  );
  return seen ? "partial" : "absent";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One machine-readable line, with the evidence behind every reading. */
export function renderDoctorJson(report: DoctorReport): string {
  return `${JSON.stringify(report)}\n`;
}

/** The human report: an issue, its signals, then the sentence it answers with. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const issue of report.issues) {
    lines.push(`${issue.title.padEnd(ISSUE_WIDTH)}${issue.verdict}`);
    if (issue.signals.length === 0) {
      lines.push("  no signal reads this issue yet");
    }
    lines.push(...issue.signals.flatMap(renderSignalLines));
    lines.push(...wrapSentence(issue.sentence));
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderSignalLines(signal: ReportedSignal): readonly string[] {
  const amount = describeAmount(signal).padEnd(AMOUNT_WIDTH);
  const source = `(${signal.thresholdSource})`.padEnd(SOURCE_WIDTH);
  return [
    `  ${signal.id.padEnd(SIGNAL_WIDTH)}${amount}${source}${signal.state}`,
    ...signal.notes.map((note) => `    note: ${note}`),
  ];
}

function describeAmount(signal: ReportedSignal): string {
  if (signal.failure !== undefined) return signal.failure;
  if (signal.direction === "floor") return `${signal.total} counted`;
  if (signal.measured === 0) return "0 seen";
  if (signal.threshold === null) {
    return `${signal.over} of ${signal.measured} seen`;
  }
  return `${signal.over} of ${signal.measured} over`;
}

function wrapSentence(sentence: string): readonly string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of sentence.split(" ")) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > SENTENCE_WIDTH) {
      lines.push(`  ${current}`);
      current = word;
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) lines.push(`  ${current}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Explaining one issue
// ---------------------------------------------------------------------------

/** What `dad doctor explain <issue-id>` prints: the essay, the test, the cure. */
export function renderIssueExplanation(
  issue: DaddyIssue,
  signals: readonly DoctorSignal[],
  profile: DoctorProfile,
): string {
  const lines = [
    issue.title,
    "",
    ...wrapSentence(issue.sentence),
    "",
    `Essay: DAD.md${issue.anchor}`,
    `Companion: docs/daddy-issues.md${issue.anchor}`,
    "",
    "Test:",
    ...issue.questions.map(
      (question, index) =>
        `  ${index + 1}. ${question.text} (${question.signals.join(", ")})`,
    ),
    "",
    "Signals Dad measures today:",
    ...(signals.length === 0
      ? ["  none yet"]
      : signals.map(
          (signal) =>
            `  ${signal.id.padEnd(SIGNAL_WIDTH)}${describeThreshold(signal, profile)}`,
        )),
    "",
    "Cure:",
    ...wrapSentence(issue.cure),
  ];
  return `${lines.join("\n")}\n`;
}
