/**
 * The local verify cache: a step whose inputs are unchanged since it last
 * passed is not run again.
 *
 * A record is `{ key, runId }` under `.dads/verify-cache/<kind>/<id>.json`
 * (gitignored, never shared). The key hashes the step's command, the Node
 * version and platform, the environment variables a tool reads, and the
 * inputs of the step's scope (`verify-workspace.mjs`). Only a pass is
 * recorded, so a failing step runs every time.
 *
 * There is no cache at all, no read and no write, when `CI` is set, with
 * `--no-cache`, or with `--full`. Fail safe throughout: a step that declares
 * no scope, a scope whose inputs cannot be determined, and a record that
 * cannot be read all mean the step runs.
 *
 * `verify.mjs` takes the fingerprint once, before any step starts, and writes
 * it where the steps that cache per package (`verify-test-step.mjs`,
 * `check-test-types.mjs`) find it through `DADS_VERIFY_CACHE_RUN`. When the run
 * ends it fingerprints the checkout again; if anything changed while the steps
 * ran, every record this run wrote is deleted, because no one knows which
 * version of a file a step read.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  captureFingerprint,
  captureHistory,
  hashPathOrAbsent,
  sameFingerprint,
  sameHistory,
} from "./verify-fingerprint.mjs";
import { scopeInputs } from "./verify-workspace.mjs";

export const CACHE_DIRECTORY = ".dads/verify-cache";
export const RUN_VARIABLE = "DADS_VERIFY_CACHE_RUN";
const KEY_VERSION = 1;
const READ_ENVIRONMENT =
  /^(?:VITEST|DADS|NODE_OPTIONS$|NODE_ENV$|TZ$|CARGO_BUILD_TARGET$|CARGO_ENCODED_RUSTFLAGS$|RUSTDOCFLAGS$|RUSTFLAGS$|RUSTUP_TOOLCHAIN$)/u;

/** Whether this run may use the cache at all, and why not. */
export function cacheDecision(options, environment) {
  if (environment.CI !== undefined && environment.CI !== "") {
    return { enabled: false, reason: "CI is set" };
  }
  if (options.noCache === true) return { enabled: false, reason: "--no-cache" };
  if (options.full === true) {
    return { enabled: false, reason: "--full runs everything" };
  }
  return { enabled: true, reason: "" };
}

/** The variables a tool reads that a key must see; ours are not among them. */
export function relevantEnvironment(environment) {
  return Object.entries(environment)
    .filter(
      ([name]) =>
        READ_ENVIRONMENT.test(name) && !name.startsWith("DADS_VERIFY_"),
    )
    .sort(([left], [right]) => (left < right ? -1 : 1));
}

/**
 * The key for one command over one scope, or null when the inputs cannot be
 * determined. `scope.files` adds files (ignored ones included) by content.
 */
export function cacheKey(context, scope, command) {
  const inputs = scopeInputs(context, scope);
  if (inputs === null) return null;
  const history = scope.history ? context.fingerprint.history : undefined;
  if (scope.history && history?.commit == null) return null;
  const files = (scope.files ?? []).map((path) => [
    path,
    hashPathOrAbsent(context.root, path),
  ]);
  const material = JSON.stringify({
    version: KEY_VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    environment: relevantEnvironment(context.environment),
    command,
    inputs,
    history,
    files,
  });
  return createHash("sha256").update(material).digest("hex");
}

function recordPath(context, kind, id) {
  return join(context.directory, kind, `${id.replaceAll("/", "__")}.json`);
}

/** Did this exact key pass before? Anything unreadable is a no. */
export function hasPassed(context, kind, id, key) {
  if (key === null) return false;
  return readRecord(context, kind, id)?.key === key;
}

export function readRecord(context, kind, id) {
  try {
    return JSON.parse(readFileSync(recordPath(context, kind, id), "utf8"));
  } catch {
    return null;
  }
}

/** Writes a pass atomically, stamped with the run that proved it. */
export function writeRecord(context, kind, id, record) {
  const path = recordPath(context, kind, id);
  mkdirSync(join(context.directory, kind), { recursive: true });
  const partial = `${path}.${randomUUID()}.partial`;
  writeFileSync(
    partial,
    `${JSON.stringify({ ...record, runId: context.runId })}\n`,
  );
  renameSync(partial, path);
}

/** Opens the cache for a whole verify run, or says why it cannot. */
export function openRunCache(root, environment) {
  const fingerprint = captureFingerprint(root);
  if (fingerprint.error !== undefined) return { error: fingerprint.error };
  const context = {
    root,
    environment,
    fingerprint,
    runId: randomUUID(),
    directory: join(root, CACHE_DIRECTORY),
    pending: [],
  };
  const runDirectory = join(context.directory, "runs", context.runId);
  mkdirSync(runDirectory, { recursive: true });
  context.runFile = join(runDirectory, "fingerprint.json");
  writeFileSync(
    context.runFile,
    JSON.stringify({ runId: context.runId, fingerprint }),
  );
  return context;
}

/**
 * The cache for a verify run, or null with the reason there is none. A
 * step's own process finds the run through `DADS_VERIFY_CACHE_RUN` in
 * `environment`, which is removed when there is no cache so an inherited one
 * cannot switch it on. With the cache off nothing is read or written.
 */
export function openVerifyCache(options, root, environment) {
  delete environment[RUN_VARIABLE];
  const decision = cacheDecision(options, environment);
  if (!decision.enabled) {
    return { cache: null, state: { ...decision, note: "" } };
  }
  const cache = openRunCache(root, environment);
  if (cache.error !== undefined) {
    const reason = `no fingerprint (${cache.error.trim()})`;
    return { cache: null, state: { enabled: false, reason, note: "" } };
  }
  environment[RUN_VARIABLE] = cache.runFile;
  return { cache, state: { enabled: true, reason: "", note: "" } };
}

/**
 * The cache as a step's own process sees it: the run's fingerprint, or null
 * when the step was started without one or under CI.
 */
export function openStepCache(root, environment) {
  const runFile = environment[RUN_VARIABLE];
  if (runFile === undefined || runFile === "") return null;
  if (!cacheDecision({}, environment).enabled) return null;
  try {
    const run = JSON.parse(readFileSync(runFile, "utf8"));
    return {
      root,
      environment,
      fingerprint: run.fingerprint,
      runId: run.runId,
      directory: join(root, CACHE_DIRECTORY),
    };
  } catch {
    return null;
  }
}

/**
 * Runs one graph step through the cache. A hit resolves at once; a pass is
 * held until the run proves the checkout did not move.
 */
export async function runThroughCache(context, step, run) {
  if (context === null) return run();
  if (step.cache === undefined) {
    const outcome = await run();
    return { ...outcome, cache: stepCacheNote(outcome.output) };
  }
  const key =
    step.cache.history && !historyUnchanged(context)
      ? null
      : cacheKey(context, step.cache, [step.command, ...step.args]);
  if (hasPassed(context, "steps", step.id, key)) {
    return { exitCode: 0, output: "", cache: "hit" };
  }
  const outcome = await run();
  if (outcome.exitCode === 0 && key !== null) {
    context.pending.push({ id: step.id, key });
  }
  return { ...outcome, cache: stepCacheNote(outcome.output) };
}

function historyUnchanged(context) {
  try {
    return sameHistory(
      context.fingerprint.history,
      captureHistory(context.root),
    );
  } catch {
    return false;
  }
}

/** The last `verify-cache:` line a step printed about its own partitions. */
function stepCacheNote(output) {
  const lines = output
    .split("\n")
    .filter((line) => line.startsWith("verify-cache: "));
  const last = lines.at(-1);
  if (last === undefined) return null;
  const note = last.slice("verify-cache: ".length).trim();
  return note === "hit" ? "hit" : note;
}

/**
 * Keeps this run's records only if the checkout is what it was when the run
 * started. Returns a sentence for the summary.
 */
export function finishRunCache(
  context,
  after = captureFingerprint(context.root),
) {
  rmSync(join(context.directory, "runs", context.runId), {
    force: true,
    recursive: true,
  });
  if (!sameFingerprint(context.fingerprint, after)) {
    discardRunRecords(context);
    return "the checkout changed while verify ran, so nothing was recorded";
  }
  for (const { id, key } of context.pending)
    writeRecord(context, "steps", id, { key });
  return "";
}

function discardRunRecords(context) {
  if (!existsSync(context.directory)) return;
  for (const kind of readdirSync(context.directory)) {
    if (kind === "runs") continue;
    for (const name of readdirSync(join(context.directory, kind))) {
      const path = join(context.directory, kind, name);
      try {
        if (JSON.parse(readFileSync(path, "utf8")).runId === context.runId)
          rmSync(path);
      } catch {
        rmSync(path, { force: true });
      }
    }
  }
}
