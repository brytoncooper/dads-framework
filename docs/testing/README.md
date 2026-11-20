# Testing soundness evidence

This guide explains how to run the Dads Testing soundness corpus and verify
its release evidence. Use the [quickstart](./quickstart.md) to plan and run
tasks in your own workspace.

The release gate for `@dads-framework/testing` reads evidence from the
deterministic synthetic soundness corpus. Selection operates on declared
tasks. Every selected task runs. The [product direction](./change-understanding-direction.md)
records the proposed analysis-only prototype and its acceptance criteria.

## Synthetic soundness corpus

`fixtures/testing-soundness/cases.json` is the oracle. It declares the task
set that a mutation must include and whether the mutation is a breaking or
conservative control case. The harness creates fresh temporary Git repositories
for each case. Each case workspace contains the shared baseline commit and one
mutation commit, and uses the repository's already-installed pinned tools.

```sh
node scripts/testing/testing-soundness.mjs \
  --dad-test "$DADS_TEST_NATIVE_BINARY" \
  --output /tmp/dads-testing-soundness.json
```

Each invocation freezes the fixture and manifest into one baseline commit and
runs every declared Vitest, TypeScript, and oxlint baseline task once. There is
no persistent cache; a failed baseline stops the run before any mutations.
Every case independently runs all mutation tasks without prerequisite blocking,
then runs the native selected plan separately and records each prerequisite
receipt. All execution workspaces are fresh clones of the untouched snapshot,
so baseline or mutation artifacts cannot leak into another execution.

The fixture's lint tasks run oxlint against an `.oxlintrc.json` that enables
the `correctness` category with the `typescript` plugin plus `no-console`; its
typecheck tasks run the native TypeScript 7 compiler installed under the
`typescript-native` alias. Both replaced ESLint and TypeScript 6 for speed
alone and produce the same pass or fail outcome on every corpus case; the only
observable difference is the compiler's failure exit code, 2 under 6 and 1
under 7, which no comparison depends on.

Schema 2 evidence includes the baseline commit, tree and manifest fingerprint,
its shared outcomes, actual task execution counts, and monotonic phase timings
for setup, baseline, mutation, native execution and total wall time. Per-case
baseline outcomes remain for compatibility; they are reused observations, not
additional executions. For 21 cases and nine tasks this runs nine baseline
tasks instead of 189, avoiding 180 tool launches. Task durations are retained.
The compared outcome is task status and exit code; diagnostics are retained but
not compared because paths and timing vary. Missing, timed-out, or spawn-failed
observations invalidate the evidence.

### Case and task concurrency

The harness defaults to `--case-jobs auto`. At startup it samples CPU activity
for about 250 milliseconds, reads the CPU parallelism available to the process,
and reads available memory. A task is one mostly single-threaded tool process,
so the CPU budget is the total number of task processes the run may keep alive
at once: the idle capacity minus one slot for the harness itself.

That budget is spent in two places. Inside a case, tasks run concurrently along
their `dependsOn` edges up to the per-case task limit, which is the CPU budget
capped by the width of the task graph — the largest number of tasks sharing a
longest-path depth, because no schedule can start more work than that. Across
cases, the case limit is the CPU budget divided by the per-case task limit and
rounded to the nearest whole case, so a wide machine runs one more case with up
to half its tasks past the budget rather than leaving that remainder idle; it
is capped again by memory (1 GiB reserved, then 1 GiB per concurrent case) and
by the number of cases in the run. Resource pressure or an unavailable probe falls
back to one case running one task at a time. This is a startup estimate for
this small fixture, not a memory limit or a promise of sustained spare
capacity.

A prerequisite orders a task; it never cancels it. Every case still runs every
declared task and records its own outcome, including a task whose prerequisite
failed. Recorded outcomes stay in manifest order, so evidence does not depend
on completion order. A task graph with an unknown prerequisite or a cycle is
refused before anything runs.

Use `--case-jobs 1` for sequential execution or a positive integer to explicitly
choose case concurrency, capped by the number of cases. An explicit value
overrides the resource estimate and runs one task at a time inside each case,
so the run holds exactly that many task processes. The native engine receives
the per-case task limit as its `jobs` count, and Vitest is capped at one worker
so nested runners do not multiply the limits. Arbitrary custom commands can
still create their own threads or subprocesses.

The baseline completes successfully before any case starts. Cases retain
separate oracle and native workspaces, and the oracle runs every mutation task.
Evidence remains sorted by case ID regardless of completion order. A failed
case is recorded while other cases continue; it cannot produce a passing run.

The `concurrency` receipt records the requested mode, the CPU and memory
budgets, the task graph width, the selected case and task limits, the resource
sample, limiting reasons, nested worker limits, and observed peak active cases.
Progress reports the selected limits and completed-case count. With
concurrency, mutation and native phase timings sum elapsed intervals across
cases and tasks and may exceed total wall time; they are not CPU-time
measurements.

The evidence is stable JSON: source SHA, tool and executable fingerprints,
task outcomes, changed paths, selected and oracle-required tasks, planner
causes, native-run receipts, and the false-negative total. `toolVersions`
records the Node version, the installed ESLint, oxlint, TypeScript, and
`typescript-native` versions, and the SHA-256 of the engine binary. More
selection than the oracle requires is recorded as an extra task; it is not
converted into a smaller oracle. A selected-plan omission of a changed task
outcome is a release-blocking false negative.

The corpus covers direct and transitive JS/TS imports, sibling exports,
re-exports and `export *`, type-only edges, literal and nonliteral dynamic
imports, literal and nonliteral CommonJS `require`, aliases and unresolved
imports, config and lock files, unsupported languages, additions, deletions,
renames, and paths outside declared ownership. Incomplete proof on an owned
path must widen through that project's declared dependency closure without
collapsing to a whole-workspace fallback. Unowned paths and global files still
require the manifest's complete fallback. Precision cases declare an exact
selected task set and forbid whole-workspace fallback; an unexpected wider
selection or a precision collapse blocks release evidence separately from
false negatives.

The two CommonJS cases execute real runtime contracts. The Web test emits the
fixture's TypeScript into a fresh temporary CommonJS tree, copies its actual
`.cjs` modules, and loads the entrypoints with Node's `createRequire`. It checks
export names and values: changing the literal require exposes an extra export,
and the nonliteral mutation removes a required marker. Both must produce an
observed `web:test` failure. The separate TypeScript tasks still check types;
runtime emission does not replace them. Temporary files and their require-cache
entries are removed even when an assertion fails.

Delete and rename cases retain current graph facts. A removed old path has no
current module evidence, so `changed-module-unavailable` identifies that path
and widens through declared project dependents. The two corpus controls still
select all nine tasks because every project belongs to that closure; this is
not a claim of narrower selection. Incremental updates rebuild after a removal,
including staged renames whose destination alone appears in the snapshot's
changed-file list, so obsolete modules and resolution edges cannot survive a
patch. Removal detection compares against the indexed HEAD, so it also catches
modules created after an older comparison base. Regressions cover committed,
staged, and unstaged changes, older bases, restoration, dependent selection,
and skipping an independent project.

### Run from a checkout

Run `npm run testing:soundness` with the repository's pinned Rust toolchain
available on `PATH`. It builds the host engine from the locked Cargo workspace
and writes `target/soundness-local.json`. Use `--dad-test` or `--output` to
supply an explicit engine or report path. CI keeps its explicit engine paths.

The packed verification task builds the host engine and stages it in a
temporary package for the clean consumer proof. The release workflow uses
its platform-specific release builds.

### Shards

`--shard <index>/<count>` runs one slice of the corpus, with a 1-based index:

```sh
node scripts/testing/testing-soundness.mjs \
  --dad-test "$DADS_TEST_NATIVE_BINARY" \
  --shard 1/3 \
  --output /tmp/dads-testing-soundness-1.json
```

Case IDs are sorted and dealt out round robin: a case belongs to the shard at
its `position % count`. The partition is deterministic, so each runner computes
its own slice with no coordination, and every case still runs on exactly one
shard on every run. Nothing is skipped, cached, or reused. `--shard 0/3`,
`--shard 4/3`, and `--shard a/b` are refused.

A shard records `shard` as its index, count, and the case IDs it ran; a run
without the flag records `null`. Every shard still records the whole sealed
corpus in `corpus.caseIds`, so a shard cannot be mistaken for a complete run.
Each shard freezes and observes its own baseline, and its concurrency budget is
sized for the cases that shard runs. The release gate merges the shard evidence
files and refuses anything that is not the whole corpus exactly once.

## Release gate

```sh
node scripts/testing/verify-testing-release.mjs --soundness /path/to/soundness.json
```

Equivalently, `npm run verify:testing-release -- --soundness <file>`. This
command blocks publication for invalid baseline or task observations, a skipped
changed task outcome, an absent or contradictory selected-run receipt, any
false negative, any precision-case selection mismatch, and any fallback-policy
failure. It has no other inputs.

`--soundness` may be repeated, once per shard of the same corpus run:

```sh
node scripts/testing/verify-testing-release.mjs \
  --soundness /tmp/dads-testing-soundness-1.json \
  --soundness /tmp/dads-testing-soundness-2.json \
  --soundness /tmp/dads-testing-soundness-3.json
```

Several files are merged before anything is judged. The shards must agree on
`sourceSha`, `toolVersions`, the corpus they loaded, and the baseline they
froze — compared by its tree and manifest fingerprints, because each shard
freezes its own workspace. Their case IDs must be disjoint, and their union
must be exactly the case IDs of `fixtures/testing-soundness/cases.json`. A
missing shard fails and names the cases nobody ran; a case run twice fails and
names it; a disagreement fails and names the field. Summary counts are summed,
the merged cases are judged as one corpus, and each shard's concurrency receipt
and timings are kept. A single file recording `shard: null` is judged exactly
as a single-runner corpus run is, so a generated fixture still verifies with
one `--soundness`.
Dads/Nx performance is a benchmark claim, not release evidence; no
performance threshold gates publication.

### Generated three-project corpus

The first deterministic generated corpus can be written to a new directory
with an unsigned 32-bit seed:

```sh
node scripts/testing/generate-testing-soundness.mjs \
  --seed 0 \
  --output /tmp/dads-testing-soundness-generated
```

The generator refuses an existing output directory. It writes a self-contained
`baseline/` workspace with `packages/p0`, `packages/p1`, and `packages/p2`,
alongside `dads.testing.json`, `cases.json`, and `graph.json`. Even seeds use a
fanout value graph (`p1` and `p2` import `p0`); odd seeds use a chain (`p1`
imports `p0`, and `p2` imports `p1`). Each project has independent lint,
typecheck, and reachability-test tasks with local prerequisites only. The
isolated `unused.ts` module provides numeric, type-error, and unattributed
console mutations for precision and conservative-widening cases. Generated
values and metadata contain no timestamps, unseeded randomness, or network
dependent content.

To run the generated fixture through the real soundness harness, set the
native Dads test binary and pass the generated directory as the fixture:

```sh
GENERATED=/tmp/dads-testing-soundness-generated
DADS_TEST_NATIVE_BINARY=/path/to/dad-test
node scripts/testing/testing-soundness.mjs \
  --fixture "$GENERATED" \
  --dad-test "$DADS_TEST_NATIVE_BINARY" \
  --output "$GENERATED/evidence.json"
node scripts/testing/verify-testing-release.mjs \
  --soundness "$GENERATED/evidence.json"
```

The generator's graph and case expectations are an independently authored
model of the generated repository. The harness then runs nine baseline tasks,
all nine tasks for each of the twelve mutations, and the native plan and
prerequisites for each case. Evidence records the generated corpus and graph
hashes, selected task decisions, mutation outcomes, and execution receipts.
This first slice covers only three TypeScript projects, explicit relative
value imports, isolated unused modules, and the even-seed fanout or odd-seed
chain topology; it does not claim coverage for other language or import
forms.

## Selection and execution cost

Dads controls which tasks it selects and how it schedules their execution.
The target is the smallest safely justified workload. It cannot guarantee
that every run finishes faster: task implementations and machine load also
determine elapsed time.

Judge selection by required work, justified skips, exact expected task sets,
and explicit fallback reasons. Missing required work is a safety failure;
running extra work is a precision concern. When analysis is uncertain, Dads
conservatively runs more work. Exact selection is proven for the declared
fixture cases, not guaranteed for every repository. Wall-clock timings are
diagnostics because machine load varies; elapsed time does not establish
selection correctness.

Reducing the proof harness's turnaround is a separate engineering goal: a
larger corpus must remain practical to run frequently. The harness deliberately
executes every mutation task, including tasks Dads skips, to independently
check those skips. Filtering the oracle with Dads' own selection would remove
the evidence needed to detect missed work.

Execution optimizations must preserve declared case and task coverage,
independent mutation observations, workspace isolation, exact selection checks,
fallback expectations, and native prerequisite and failure receipts. Missing
or incomplete observations remain failures. Compare normalized evidence with
the reference execution before accepting an optimization, and retain checks
for state leakage and failure handling. Scheduling and grouping may change;
the evidence obligations do not.

Track logical task observations separately from process launches and repeated
setup. A future coalesced invocation can execute several logical tasks while
retaining each task's result. Any reused observation must identify its captured
inputs and original execution; it must not be counted as new work. Timings
remain useful for evaluating harness changes under comparable conditions,
alongside these work counts.

## Adopters

Dads Testing is proven only on fixtures Dads owns. A repository adopting it
(the origin application included) integrates through a plan-only shadow job in
its own CI, run beside the existing affected computation:

```sh
dad-test plan --base "$BASE" --report dads-testing-report.json --json
```

The report is archived per run. `dad-test explain` reads back why a specific
task ran or was skipped when a mismatch needs investigating. No execution
campaign, no VM, and no adopter evidence enters the Dads release gate. A
mismatch the shadow job finds becomes a new case in `fixtures/testing-soundness`.
