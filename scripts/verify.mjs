/**
 * `npm run verify` — every proof this repository holds itself to, run as wide
 * as the machine allows.
 *
 * The steps are the ones the old `&&` chain ran, declared as a graph in
 * `verify-graph.mjs` with the one thing each waits for. Independent steps
 * stop queueing behind each other, and locally a step whose inputs are
 * unchanged since it last passed is skipped (`verify-cache.mjs`). With `CI`
 * set, `--no-cache`, or `--full` there is no cache: every step runs.
 *
 *   node scripts/verify.mjs                 the machine decides how wide
 *   node scripts/verify.mjs --jobs 2        a fixed budget
 *   node scripts/verify.mjs --serial        one at a time, the chain's order
 *   node scripts/verify.mjs --fail-fast     start nothing after a failure
 *   node scripts/verify.mjs --full          plus everything CI runs elsewhere:
 *                                           adoption proofs, Rust, the corpus
 *   node scripts/verify.mjs --with-doctor   then the doctor's report over this
 *                                           repository, dated today
 *   node scripts/verify.mjs --checkup       --full --with-doctor
 *   node scripts/verify.mjs --no-cache      run every step, read and write no
 *                                           step cache
 *   node scripts/verify.mjs --require-receipt
 *                                           require a committed-tree receipt
 *
 * `DADS_VERIFY_JOBS` is `--jobs` for CI. `--fail-fast` is never the default,
 * in CI included: a run that stops at the first failure hides the others, and
 * the point of a run is to show every failure it can find at once. A failed
 * step still blocks the steps that need it. The exit code is the first
 * failure's exit code.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { budgetFromResources, budgetReceipt, requestedBudget, sampleVerifyResources } from "./verify-budget.mjs";
import { finishRunCache, openVerifyCache, runThroughCache } from "./verify-cache.mjs";
import { captureFingerprint } from "./verify-fingerprint.mjs";
import { withCacheScopes } from "./verify-cache-scopes.mjs";
import { verifySteps } from "./verify-graph.mjs";
import { blockedLine, failureBlock, finishLine, startLine, summaryBlock } from "./verify-report.mjs";
import { captureProof, recordProof } from "./verify-receipt.mjs";
import { runVerifyGraph } from "./verify-scheduler.mjs";
import { spawnStep } from "./verify-spawn.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const USAGE =
  "--jobs <n>, --serial, --full, --with-doctor, --checkup, --fail-fast, --no-fail-fast, --no-cache, --require-receipt";
const DOCTOR = "packages/foundation/toolbox/bin/dad.js";

function parseArguments(argv) {
  const options = {
    jobs: null,
    serial: false,
    full: false,
    withDoctor: false,
    failFast: null,
    noCache: false,
    requireReceipt: false,
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag === "--serial") options.serial = true;
    else if (flag === "--full") options.full = true;
    else if (flag === "--with-doctor") options.withDoctor = true;
    else if (flag === "--checkup") {
      options.full = true;
      options.withDoctor = true;
    } else if (flag === "--fail-fast") options.failFast = true;
    else if (flag === "--no-fail-fast") options.failFast = false;
    else if (flag === "--no-cache") options.noCache = true;
    else if (flag === "--require-receipt") options.requireReceipt = true;
    else if (flag === "--jobs") options.jobs = wholeNumber(rest.shift(), "--jobs");
    else throw new Error(`Unknown option "${String(flag)}". Known options: ${USAGE}.`);
  }
  return options;
}

function wholeNumber(value, origin) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${origin} needs a positive whole number, not "${String(value)}".`);
  }
  return Number(value);
}

async function resolveBudget(options, environment) {
  if (options.jobs !== null && options.serial) {
    throw new Error("--serial and --jobs disagree. Pass one of them.");
  }
  if (options.jobs !== null) return requestedBudget(options.jobs, "--jobs");
  if (options.serial) return requestedBudget(1, "--serial");
  const requested = environment.DADS_VERIFY_JOBS;
  if (requested !== undefined && requested !== "") {
    return requestedBudget(wholeNumber(requested, "DADS_VERIFY_JOBS"), "DADS_VERIFY_JOBS");
  }
  return budgetFromResources(await sampleVerifyResources());
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

function printEvent(event) {
  if (event.type === "start") {
    say(startLine(event.step));
    return;
  }
  if (event.type === "blocked") {
    say(blockedLine(event));
    return;
  }
  say(finishLine(event));
  if (event.status === "failed") say(failureBlock(event));
}

async function main() {
  process.env.GIT_NO_REPLACE_OBJECTS = "1";
  const options = parseArguments(process.argv.slice(2));
  const budget = await resolveBudget(options, process.env);
  const receipt = budgetReceipt(budget);
  const steps = withCacheScopes(verifySteps(options));
  const scope = options.full ? "full, everything CI runs" : "verify job";
  say(`verify: ${steps.length} steps (${scope}), ${receipt}`);
  const { cache, state } = openVerifyCache(options, ROOT, process.env);
  const before = captureProof(ROOT, cache?.fingerprint);
  if (options.requireReceipt && before === null) {
    if (cache !== null) finishRunCache(cache, cache.fingerprint);
    throw new Error("Verification receipts require a clean, committed checkout.");
  }
  const run = await runVerifyGraph({
    steps,
    budget: budget.jobs,
    serial: options.serial,
    failFast: options.failFast ?? false,
    runStep: (step) => runThroughCache(cache, step, () => spawnStep(step, ROOT)),
    onEvent: printEvent,
  });
  const after = cache === null ? undefined : captureFingerprint(ROOT);
  if (cache !== null) state.note = finishRunCache(cache, after);
  say(summaryBlock({ ...run, receipt, budget, cacheState: state }));
  if (options.withDoctor) printCheckup();
  process.exitCode = run.exitCode;
  if (run.exitCode === 0) {
    const recorded = recordProof(ROOT, before, run, { full: options.full, uncached: cache === null }, after);
    if (recorded) say("verify: recorded a proof receipt for the committed checkout");
    else if (options.requireReceipt)
      throw new Error("No proof receipt was recorded. Check that verification left its inputs unchanged.");
  }
}

/**
 * The doctor's report after the proofs: what is wrong, not whether the gate
 * held. A report never fails, so it moves no exit code; the date is the
 * runner's, because the doctor itself reads no clock.
 */
function printCheckup() {
  const today = new Date().toISOString().slice(0, 10);
  say("");
  say(`checkup: dad doctor . --today ${today}`);
  say("");
  const report = spawnSync(process.execPath, [DOCTOR, "doctor", ".", "--today", today], {
    cwd: ROOT,
    encoding: "utf8",
  });
  process.stdout.write(report.stdout);
  if (report.status !== 0) {
    say(`checkup: the doctor exited ${String(report.status)}`);
    process.stderr.write(report.stderr);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
