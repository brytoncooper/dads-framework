/**
 * How much of the machine one `npm run verify` run may use, and why.
 *
 * The budget is a slot count: the sum of the weights of the steps running at
 * once may not exceed it. It comes from the same reading the soundness corpus
 * takes — idle CPU capacity minus one slot for the runner itself, capped by
 * free memory above a one-gibibyte floor — so a laptop under load runs a
 * couple of steps and an idle workstation runs a dozen.
 *
 * Every number that goes into the decision is kept and printed as a receipt,
 * because a run that chose a budget without saying why is a run nobody can
 * argue with.
 */

import { availableParallelism, freemem } from "node:os";
import process from "node:process";

const GIBIBYTE = 1024 ** 3;

/**
 * The corpus owns the probe. It is another lane's file, so it is imported
 * dynamically and shape-checked: a static named import of an export that is
 * not there yet is a link-time error that takes the whole runner down.
 */
const CORPUS_PROBE = "./testing/testing-soundness-concurrency.mjs";

/** Reads the host, through the corpus probe when it is available. */
export async function sampleVerifyResources() {
  const attempt = await probeThroughCorpus();
  if (attempt.sample !== null) return attempt.sample;
  return fallbackSample(attempt.reason);
}

async function probeThroughCorpus() {
  try {
    const probe = await import(CORPUS_PROBE);
    if (typeof probe.sampleResources !== "function") {
      return {
        sample: null,
        reason: "the corpus probe exports no sampleResources()",
      };
    }
    const reading = await probe.sampleResources();
    if (!usableReading(reading)) {
      return {
        sample: null,
        reason: "the corpus probe returned an unusable reading",
      };
    }
    return { sample: corpusSample(reading), reason: null };
  } catch (error) {
    return {
      sample: null,
      reason: `the corpus probe failed (${messageOf(error)})`,
    };
  }
}

function corpusSample(reading) {
  return {
    source: "corpus probe",
    cpuCapacity: reading.cpuCapacity,
    cpuIdleFraction: reading.cpuIdleFraction,
    availableMemoryBytes: reading.availableMemoryBytes,
    note: null,
  };
}

/**
 * `os.availableParallelism()` with no idle reading at all, so the machine is
 * assumed idle, and the same memory reading the corpus probe takes:
 * `process.availableMemory()` where it exists, `os.freemem()` otherwise. On
 * macOS `freemem()` counts only wholly unused pages and reported 4.1 GiB on a
 * host where 14.2 GiB was actually available, which bought a third of the
 * budget the machine could carry. The note says which reading was used and the
 * receipt prints it.
 */
function fallbackSample(reason) {
  const available = typeof process.availableMemory === "function";
  return {
    source: "os fallback",
    cpuCapacity: availableParallelism(),
    cpuIdleFraction: 1,
    availableMemoryBytes: available ? process.availableMemory() : freemem(),
    note: `${reason}; assuming an idle machine, memory from ${available ? "process.availableMemory()" : "os.freemem()"}`,
  };
}

function usableReading(reading) {
  return (
    reading !== null &&
    typeof reading === "object" &&
    Number.isSafeInteger(reading.cpuCapacity) &&
    reading.cpuCapacity > 0 &&
    Number.isFinite(reading.cpuIdleFraction) &&
    reading.cpuIdleFraction >= 0 &&
    reading.cpuIdleFraction <= 1 &&
    Number.isFinite(reading.availableMemoryBytes) &&
    reading.availableMemoryBytes >= 0 &&
    Array.isArray(reading.probeErrors) &&
    reading.probeErrors.length === 0
  );
}

/**
 * The slot budget a host sample buys, with every input kept.
 *
 * A slot is one core and one gibibyte. The gibibyte is the measurement, not a
 * round number: ESLint's typed pass peaked at 1.94 GiB of resident memory at
 * weight two, and the single-threaded checks peak near a tenth of that. One
 * gibibyte is held back for the machine itself before the division.
 */
export function budgetFromResources(sample) {
  const cpuBudget = Math.max(
    1,
    Math.floor(sample.cpuCapacity * sample.cpuIdleFraction - 1),
  );
  const memoryBudget = Math.max(
    1,
    Math.floor(Math.max(0, sample.availableMemoryBytes - GIBIBYTE) / GIBIBYTE),
  );
  const jobs = Math.min(cpuBudget, memoryBudget);
  return {
    jobs,
    mode: "sampled",
    source: sample.source,
    cpuCapacity: sample.cpuCapacity,
    cpuIdleFraction: sample.cpuIdleFraction,
    availableMemoryBytes: sample.availableMemoryBytes,
    cpuBudget,
    memoryBudget,
    limits: limitingReasons(jobs, cpuBudget, memoryBudget),
    note: sample.note,
  };
}

function limitingReasons(jobs, cpuBudget, memoryBudget) {
  const limits = [];
  if (jobs === cpuBudget) limits.push("idle CPU");
  if (jobs === memoryBudget) limits.push("free memory");
  if (jobs === 1) limits.push("one-job minimum");
  return limits;
}

/** A budget the caller asked for: `--jobs`, `DADS_VERIFY_JOBS`, `--serial`. */
export function requestedBudget(jobs, origin) {
  if (!Number.isSafeInteger(jobs) || jobs < 1) {
    throw new Error(
      `${origin} must be a positive whole number, not "${jobs}".`,
    );
  }
  return {
    jobs,
    mode: "requested",
    source: origin,
    cpuCapacity: null,
    cpuIdleFraction: null,
    availableMemoryBytes: null,
    cpuBudget: null,
    memoryBudget: null,
    limits: [origin],
    note: null,
  };
}

/** One line saying what the budget is and every number behind it. */
export function budgetReceipt(budget) {
  const head = `budget ${budget.jobs} slot${budget.jobs === 1 ? "" : "s"} (${budget.source})`;
  if (budget.mode === "requested") return head;
  const cores = `${budget.cpuCapacity} cores x ${budget.cpuIdleFraction.toFixed(2)} idle - 1 = ${budget.cpuBudget}`;
  const memory = `${gibibytes(budget.availableMemoryBytes)} GiB free - 1 = ${budget.memoryBudget}`;
  const tail = budget.note === null ? "" : `; ${budget.note}`;
  return `${head}: ${cores}, ${memory}; limited by ${budget.limits.join(" and ")}${tail}`;
}

function gibibytes(bytes) {
  return (bytes / GIBIBYTE).toFixed(1);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
