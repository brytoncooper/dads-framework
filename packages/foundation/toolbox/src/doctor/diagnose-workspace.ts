/**
 * One call that reads a repository and answers with the doctor's report.
 *
 * `dad doctor` is a command, and a command is an awkward thing for another
 * program to depend on: `create-dads` wants the diagnosis, not the exit code,
 * the argument list, or the bytes on standard output. This function is the
 * library form of the same run — the context, the signals the selected issues
 * evidence, and the grouped report — so a caller renders it, embeds it in its
 * own JSON, or reads a single verdict, and the CLI stays the only place that
 * decides what a terminal sees.
 *
 * It reports; it never throws for what it found. A signal that cannot answer
 * is one `not measured` line inside the report, because a diagnosis that dies
 * on the first unreadable input is worse than a diagnosis with a gap in it.
 *
 * Nothing here reads the clock. `today` arrives from the caller or the signals
 * that need a date say they were not measured, so two runs over the same tree
 * answer with the same bytes.
 */

import { createDoctorContext } from "./doctor-context.js";
import { buildDoctorReport, type DoctorReport } from "./doctor-report.js";
import { signalEvidences, type DoctorProfile } from "./doctor-signal.js";
import { DOCTOR_SIGNALS, runDoctorSignals } from "./doctor-signals.js";
import { DADDY_ISSUES, findDaddyIssue, type DaddyIssue } from "./issues.js";

export type DiagnoseWorkspaceOptions = {
  /** The repository to read. Relative paths resolve against the process. */
  readonly root: string;
  /** The date the signals that need one measure against, as `YYYY-MM-DD`. */
  readonly today?: string | undefined;
  /** The thresholds to judge against. `standard` when it is not named. */
  readonly profile?: DoctorProfile | undefined;
  /** Issue ids to narrow the report to. Every issue when it is not named. */
  readonly issues?: readonly string[] | undefined;
  /** Whether the three signals that ask the network may run. Off by default. */
  readonly online?: boolean | undefined;
};

/**
 * Runs the signals the selected issues evidence and groups them into a report.
 * A cross-listed signal is measured once and reported under every issue it
 * evidences, so narrowing to one issue still runs the signals another issue
 * calls its own.
 */
export async function diagnoseWorkspace(
  options: DiagnoseWorkspaceOptions,
): Promise<DoctorReport> {
  const issues = selectIssues(options.issues);
  const context = createDoctorContext({
    root: options.root,
    today: options.today,
    online: options.online ?? false,
  });
  const selected = issues.map((issue) => issue.id);
  const signals = DOCTOR_SIGNALS.filter((signal) =>
    selected.some((issue) => signalEvidences(signal, issue)),
  );
  const outcomes = await runDoctorSignals(context, signals);
  return buildDoctorReport({
    root: context.root,
    profile: options.profile ?? "standard",
    today: options.today,
    outcomes,
    issues,
  });
}

/**
 * The issues to report, always in the order `DAD.md` raises them: naming a
 * subset narrows the report, it does not reorder it. An id nothing carries is
 * a mistake in the call rather than a finding, so it is refused by name.
 */
function selectIssues(
  chosen: readonly string[] | undefined,
): readonly DaddyIssue[] {
  if (chosen === undefined || chosen.length === 0) return DADDY_ISSUES;
  for (const id of chosen) {
    if (findDaddyIssue(id) === undefined) {
      throw new Error(`No daddy issue is named ${id}.`);
    }
  }
  const named = new Set(chosen);
  return DADDY_ISSUES.filter((issue) => named.has(issue.id));
}
