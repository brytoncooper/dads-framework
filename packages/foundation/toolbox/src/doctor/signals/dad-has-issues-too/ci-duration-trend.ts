/**
 * How long the gate has been taking: information, in both profiles.
 *
 * This is the one reading in the doctor that is not a rule and cannot become
 * one. No number of minutes is an illness — a workspace that compiles four
 * languages has earned its twenty — and a threshold here would be Dad deciding
 * how long your build is allowed to be, which is the helicopter dad this issue
 * is about. So it reports and moves no verdict.
 *
 * It is here because a gate people route around is the failure this issue owns,
 * and the most common reason they route around one is that it got slow while
 * nobody was watching. The median of a workflow's last runs is what makes that
 * arguable: it is stable against the one run that queued for an hour, and it is
 * the number somebody can point at when they say the gate has doubled.
 *
 * The duration is the run's own: from the moment it started to the moment it
 * last changed, in whole minutes, keyed by workflow name. Nothing here reads a
 * clock — both ends of every interval come out of the response.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  readJsonObject,
  readObjectArray,
  readStringField,
  repositoryUrl,
  requireOnline,
  requireOriginRepository,
} from "../scanners/online-requests.js";

/** The window the catalog asks for: the last twenty runs that finished. */
const RECENT_RUNS = "actions/runs?per_page=20&status=completed";
const GITHUB = "https://github.com";
const MINUTE_MILLISECONDS = 60_000;
const HALF = 2;

async function measureCiDuration(
  context: DoctorContext,
): Promise<SignalReadings> {
  requireOnline(context);
  const named = requireOriginRepository(context);
  const document = await readJsonObject(
    context,
    `${repositoryUrl(named)}/${RECENT_RUNS}`,
  );
  const actions = `${GITHUB}/${named.owner}/${named.repository}/actions`;
  const readings = new Map<string, SignalReading>();
  for (const [workflow, minutes] of runMinutesByWorkflow(document)) {
    readings.set(workflow, {
      value: medianMinutes(minutes),
      evidence: [{ path: actions, name: `${minutes.length} completed runs` }],
    });
  }
  return readings;
}

/** Every listed run's length in minutes, gathered under its workflow's name. */
function runMinutesByWorkflow(
  document: Record<string, unknown>,
): ReadonlyMap<string, readonly number[]> {
  const gathered = new Map<string, number[]>();
  for (const run of readObjectArray(document, "workflow_runs")) {
    const workflow = readStringField(run, "name");
    const minutes = runMinutes(run);
    if (workflow === undefined || minutes === undefined) continue;
    gathered.set(workflow, [...(gathered.get(workflow) ?? []), minutes]);
  }
  return gathered;
}

/** One run's length, or `undefined` when it does not carry both ends. */
function runMinutes(run: Record<string, unknown>): number | undefined {
  const started = Date.parse(readStringField(run, "run_started_at") ?? "");
  const ended = Date.parse(readStringField(run, "updated_at") ?? "");
  if (Number.isNaN(started) || Number.isNaN(ended)) return undefined;
  return Math.max(0, (ended - started) / MINUTE_MILLISECONDS);
}

/** The middle run, in whole minutes, so one queued hour cannot be the trend. */
function medianMinutes(minutes: readonly number[]): number {
  const sorted = [...minutes].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / HALF);
  const above = sorted[middle] ?? 0;
  if (sorted.length % HALF === 1) return Math.round(above);
  return Math.round(((sorted[middle - 1] ?? 0) + above) / HALF);
}

export const ciDurationTrendSignal: DoctorSignal = {
  id: "ci-duration-trend",
  issue: "dad-has-issues-too",
  question:
    "How long has each workflow taken over its last completed runs? (report-only)",
  reads: "online",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: null },
  sentence: "Dad would rather be argued with than ignored.",
  run: (context) => measureCiDuration(context),
};
