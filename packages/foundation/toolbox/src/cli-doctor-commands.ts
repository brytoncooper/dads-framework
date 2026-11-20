/**
 * `dad doctor`: the daddy issues as a diagnosis.
 *
 * The command reads a repository, reports each issue in `DAD.md` order as
 * measured signals with the threshold each was judged against, and explains
 * one issue in the document's own words. It reports; it does not fail. The
 * flags that make it a gate belong to a later phase and are refused by name
 * until then, because a flag that is silently ignored is worse than one that
 * is not there.
 *
 * Nothing here reads the clock. A date arrives through `--today` or the
 * signals that need one say they were not measured.
 */

import { commandDocumentation, documentedError } from "./cli-documentation.js";
import {
  GATE_FLAGS,
  GATE_ONLY_OPTIONS,
  GATE_OPTIONS,
  readGateMode,
  runGateCommand,
} from "./cli-doctor-gate.js";
import {
  createDoctorContext,
  type DoctorContextInput,
} from "./doctor/doctor-context.js";
import type { GateMode } from "./doctor/doctor-gate-model.js";
import {
  buildDoctorReport,
  renderDoctorJson,
  renderDoctorReport,
  renderIssueExplanation,
  type DoctorReport,
} from "./doctor/doctor-report.js";
import { signalEvidences, type DoctorProfile } from "./doctor/doctor-signal.js";
import {
  DOCTOR_SIGNALS,
  runDoctorSignals,
  signalsForIssue,
} from "./doctor/doctor-signals.js";
import {
  DADDY_ISSUES,
  findDaddyIssue,
  type DaddyIssue,
  type DaddyIssueId,
} from "./doctor/issues.js";

const VALUE_OPTIONS = new Set([
  "--profile",
  "--issue",
  "--today",
  ...GATE_OPTIONS,
  ...GATE_ONLY_OPTIONS,
]);
const PROFILES = new Set(["standard", "strict"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DoctorArguments = {
  readonly path: string | undefined;
  readonly profile: DoctorProfile;
  readonly issues: readonly DaddyIssue[];
  readonly today: string | undefined;
  readonly explain: string | undefined;
  /** The gate the flags asked for, or `undefined` for the report. */
  readonly gate: GateMode | undefined;
  /** Whether `--issue` narrowed the run, which the gate needs to know. */
  readonly issuesNarrowed: boolean;
  /** Whether the three signals that ask the network may run. */
  readonly online: boolean;
};

// ---------------------------------------------------------------------------
// The argument list
// ---------------------------------------------------------------------------

/** Splits the argument list, refusing every flag this phase cannot honour. */
export function parseDoctorArguments(
  commandArguments: readonly string[],
): DoctorArguments {
  const read = readArgumentList(commandArguments);
  return toDoctorArguments(read.values, read.flags, read.positional);
}

type ReadArguments = {
  readonly values: ReadonlyMap<string, string[]>;
  readonly flags: ReadonlySet<string>;
  readonly positional: readonly string[];
};

/** Splits the list into flags, `--name value` options, and positionals. */
function readArgumentList(commandArguments: readonly string[]): ReadArguments {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const positional: string[] = [];
  let index = 0;
  while (index < commandArguments.length) {
    const argument = commandArguments[index] ?? "";
    index += 1;
    if (
      argument === "--json" ||
      argument === "--online" ||
      GATE_FLAGS.has(argument)
    ) {
      flags.add(argument);
      continue;
    }
    if (!VALUE_OPTIONS.has(argument)) {
      positional.push(readPositional(argument));
      continue;
    }
    const value = commandArguments[index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    values.set(argument, [...(values.get(argument) ?? []), value]);
    index += 1;
  }
  return { values, flags, positional };
}

function readPositional(argument: string): string {
  if (argument.startsWith("--")) {
    throw new Error(`Unknown option ${argument}.`);
  }
  return argument;
}

function toDoctorArguments(
  values: ReadonlyMap<string, string[]>,
  flags: ReadonlySet<string>,
  positional: readonly string[],
): DoctorArguments {
  const explain = positional[0] === "explain" ? positional[1] : undefined;
  const paths = positional[0] === "explain" ? positional.slice(2) : positional;
  if (paths.length > 1) {
    throw new Error("doctor takes at most one path.");
  }
  if (positional[0] === "explain" && explain === undefined) {
    throw new Error("doctor explain requires an issue id.");
  }
  const profile = readProfile(values);
  const today = readToday(values);
  const gate = readGateMode({ flags, values, profile, today });
  if (explain !== undefined && gate !== undefined) {
    throw new Error("doctor explain reports; it cannot be a gate.");
  }
  return {
    path: paths[0],
    profile,
    issues: readIssues(values),
    today,
    explain,
    gate,
    issuesNarrowed: values.has("--issue"),
    online: flags.has("--online"),
  };
}

function readProfile(values: ReadonlyMap<string, string[]>): DoctorProfile {
  const chosen = values.get("--profile")?.at(-1);
  if (chosen === undefined) return "standard";
  if (!PROFILES.has(chosen)) {
    throw new Error("--profile must be standard or strict.");
  }
  return chosen === "strict" ? "strict" : "standard";
}

/**
 * The issues to report, always in the order `DAD.md` raises them: `--issue`
 * narrows the report, it does not reorder it.
 */
function readIssues(
  values: ReadonlyMap<string, string[]>,
): readonly DaddyIssue[] {
  const chosen = values.get("--issue") ?? [];
  if (chosen.length === 0) return DADDY_ISSUES;
  for (const id of chosen) {
    if (findDaddyIssue(id) === undefined) {
      throw new Error(`No daddy issue is named ${id}.`);
    }
  }
  const named = new Set(chosen);
  return DADDY_ISSUES.filter((issue) => named.has(issue.id));
}

function readToday(values: ReadonlyMap<string, string[]>): string | undefined {
  const chosen = values.get("--today")?.at(-1);
  if (chosen !== undefined && !DATE.test(chosen)) {
    throw new Error("--today must be a date written YYYY-MM-DD.");
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// The diagnosis
// ---------------------------------------------------------------------------

export type DiagnoseOptions = {
  readonly root: string;
  readonly profile: DoctorProfile;
  readonly today: string | undefined;
  readonly issues: readonly DaddyIssue[];
  readonly exec?: DoctorContextInput["exec"];
  /** Whether the network may be asked; `false` when it is not named. */
  readonly online?: boolean;
};

/**
 * Runs the signals the selected issues evidence and groups them into a report.
 * A cross-listed signal is one of them: `--issue` names an issue, and every
 * signal reported under that issue runs, whichever issue it calls its own.
 */
export async function diagnoseRepository(
  options: DiagnoseOptions,
): Promise<DoctorReport> {
  const context = createDoctorContext({
    root: options.root,
    today: options.today,
    exec: options.exec,
    online: options.online ?? false,
  });
  const selected = options.issues.map((issue) => issue.id);
  const signals = DOCTOR_SIGNALS.filter((signal) =>
    selected.some((issue) => signalEvidences(signal, issue)),
  );
  const outcomes = await runDoctorSignals(context, signals);
  return buildDoctorReport({
    root: context.root,
    profile: options.profile,
    today: options.today,
    outcomes,
    issues: options.issues,
  });
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/**
 * `dad doctor [path] [...]`, `dad doctor explain <issue-id>`, and the gate.
 * The report exits zero whatever it found; the gate exits one on a violation,
 * which is the whole difference between describing a repository and holding
 * one.
 */
export async function doctor(
  commandArguments: readonly string[],
  json: boolean,
): Promise<number> {
  const parsed = parseDoctorCommand(commandArguments);
  if (parsed.explain !== undefined) {
    explainDaddyIssue(parsed, json);
    return 0;
  }
  const root = parsed.path ?? process.cwd();
  if (parsed.gate !== undefined) {
    const result = await runGateCommand({
      root,
      mode: parsed.gate,
      issues: parsed.issues,
      issuesNarrowed: parsed.issuesNarrowed,
    });
    process.stdout.write(result.output);
    return result.exitCode;
  }
  const report = await diagnoseRepository({
    root,
    profile: parsed.profile,
    today: parsed.today,
    issues: parsed.issues,
    online: parsed.online,
  });
  process.stdout.write(
    json ? renderDoctorJson(report) : renderDoctorReport(report),
  );
  return 0;
}

function parseDoctorCommand(
  commandArguments: readonly string[],
): DoctorArguments {
  try {
    return parseDoctorArguments(commandArguments);
  } catch (error) {
    throw documentedError(
      error,
      commandDocumentation(process.cwd(), "docs/doctor.md"),
    );
  }
}

function explainDaddyIssue(parsed: DoctorArguments, json: boolean): void {
  const manual = commandDocumentation(
    parsed.path ?? process.cwd(),
    "docs/daddy-issues.md",
  );
  const issue = findDaddyIssue(parsed.explain ?? "");
  if (issue === undefined) {
    throw documentedError(
      `No daddy issue is named ${parsed.explain ?? ""}.`,
      manual,
    );
  }
  const documentation = manual.endsWith("daddy-issues.md")
    ? `${manual}#${issue.id}`
    : manual;
  const signals = signalsForIssue(issue.id);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, issue, signals: signals.map(describeSignal), documentation })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${renderIssueExplanation(issue, signals, parsed.profile)}\nSee ${documentation}\n`,
  );
}

function describeSignal(signal: (typeof DOCTOR_SIGNALS)[number]) {
  return {
    id: signal.id,
    question: signal.question,
    reads: signal.reads,
    unit: signal.unit,
    direction: signal.direction,
    thresholds: signal.thresholds,
    sentence: signal.sentence,
    measure: signal.measure,
  };
}

/** Every issue id, for the usage line and for tests. */
export function daddyIssueIds(): readonly DaddyIssueId[] {
  return DADDY_ISSUES.map((issue) => issue.id);
}
