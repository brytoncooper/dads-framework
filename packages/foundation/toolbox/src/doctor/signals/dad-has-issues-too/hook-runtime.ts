import { isRecord } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";

const TIMING_FILE = ".dads/hook-timings.jsonl";
const RECENT_SAMPLES = 20;
const BUDGETS = { "pre-commit": 10_000, "pre-push": 60_000 };

function addSample(line: string, samples: Map<string, number[]>): void {
  let sample: unknown;
  try {
    sample = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(sample)) return;
  const hook = sample["hook"];
  const duration = sample["durationMs"];
  if (typeof hook !== "string" || typeof duration !== "number") return;
  if (!Number.isFinite(duration) || duration < 0) return;
  samples.get(hook)?.push(duration);
}

function hookReading(
  hook: string,
  samples: readonly number[],
  budget: number,
  context: DoctorContext,
): SignalReading {
  const recent = samples.slice(-RECENT_SAMPLES).sort((a, b) => a - b);
  const middle = Math.floor(recent.length / 2);
  const upper = recent[middle] ?? 0;
  const lower = recent[middle - 1] ?? upper;
  const median = recent.length % 2 === 0 ? (lower + upper) / 2 : upper;
  const summary = `${hook} median ${median} ms across ${recent.length} samples (budget ${budget} ms)`;
  context.notes?.push(summary);
  return {
    value: Math.round((median / budget) * 100),
    evidence: [{ path: TIMING_FILE, name: summary }],
  };
}

function measureHookRuntime(context: DoctorContext): SignalReadings {
  if (!context.exists(TIMING_FILE))
    throw new Error("no local hook timing samples");
  const samples = new Map<string, number[]>(
    Object.keys(BUDGETS).map((hook) => [hook, []]),
  );
  for (const line of context.read(TIMING_FILE).split("\n")) {
    addSample(line, samples);
  }
  const readings = new Map<string, SignalReading>();
  for (const [hook, budget] of Object.entries(BUDGETS)) {
    const measured = samples.get(hook);
    if (measured === undefined || measured.length === 0) continue;
    readings.set(hook, hookReading(hook, measured, budget, context));
  }
  if (readings.size === 0)
    throw new Error("no valid local hook timing samples");
  return readings;
}

export const hookRuntimeSignal: DoctorSignal = {
  id: "hook-runtime",
  issue: "dad-has-issues-too",
  question: "How much of the runtime budget do local Git hooks typically use?",
  reads: "text",
  unit: "percent",
  direction: "ceiling",
  thresholds: { standard: null, strict: null },
  reportOnly: true,
  sentence:
    "A no that cannot explain itself is a no the kids will route around.",
  run: (context) => Promise.resolve(measureHookRuntime(context)),
};
