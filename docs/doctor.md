# `dad doctor`

[`DAD.md`](../DAD.md) names seventeen ways a codebase fails when nobody holds a
boundary. The essay tells you what they look like. `dad doctor` tells you which
ones you have.

It reads a repository, groups the measured signals under the issue they
evidence, and prints each with the number, the threshold, and where the
threshold came from. Dad judges, with receipts. A verdict a reader cannot check
is one they will route around.

## The command

```sh
dad doctor [path] [--profile standard|strict] [--issue <id>]... [--today <date>] [--online] [--json]
dad doctor [path] --gate [--profile <name>] [--file <path>] [--base <ref>] [--json]
dad doctor [path] --seed --today <date> [--key <key>] [--reason <text>]
dad doctor [path] --update|--report [--json]
dad doctor explain <issue-id> [--profile standard|strict] [--json]
```

`path` is the repository to read, and the working directory when it is not
given. `doctor` takes at most one path.

| Option                       | What it does                                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--profile standard\|strict` | The thresholds to judge against. `standard` when it is not given.                                                                                                                                                    |
| `--issue <id>`               | Narrows the run to one issue. Repeatable. The report keeps `DAD.md` order rather than the argument order.                                                                                                            |
| `--today YYYY-MM-DD`         | The date the signals that measure an age are read against.                                                                                                                                                           |
| `--online`                   | Lets the three signals that ask the network run: the npm registry for unmaintained dependencies, GitHub for branch protection and workflow durations. Off by default; without it they read `not measured (offline)`. |
| `--json`                     | One machine-readable line carrying the same structure, with the evidence behind every reading.                                                                                                                       |
| `--gate`                     | Judges the repository against the recorded baseline instead of describing it.                                                                                                                                        |
| `--update`                   | Applies every downward move the baseline allows.                                                                                                                                                                     |
| `--seed`                     | Records today's numbers as exceptions. Requires `--today`.                                                                                                                                                           |
| `--report`                   | Lists what the baseline records and what is over it.                                                                                                                                                                 |
| `--file <path>`              | Measures one repository-relative path, whether or not git has seen it.                                                                                                                                               |
| `--base <ref>`               | Compares this baseline against the one at a git ref. Reads only.                                                                                                                                                     |
| `--key <key>`                | The one key `--seed` records. Requires `--seed`.                                                                                                                                                                     |
| `--reason <text>`            | The reason a seeded entry carries beside its date. Requires `--seed`.                                                                                                                                                |

Nothing reads the clock. A signal that needs a date and was given none says it
was not measured, so two runs over the same tree print the same bytes.

Errors, and when each happens:

| Message                                                             | When                                               |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| `doctor takes at most one path.`                                    | A second positional path was given                 |
| `Unknown option <option>.`                                          | An option this command does not accept             |
| `<option> requires a value.`                                        | A value option with no value after it              |
| `--profile must be standard or strict.`                             | An unrecognized profile                            |
| `--today must be a date written YYYY-MM-DD.`                        | A date in any other shape                          |
| `No daddy issue is named <id>.`                                     | `--issue` or `explain` named an id nothing carries |
| `doctor explain reports; it cannot be a gate.`                      | `explain` combined with a gate flag                |
| `--seed needs --today YYYY-MM-DD.`                                  | Seeding without the date it would record           |
| `--seed and --update are exclusive.`                                | Both asked for at once                             |
| `--base only reads; it cannot be combined with --update or --seed.` | A comparison asked to write                        |
| `--file cannot be combined with --base or --seed.`                  | One path asked to stand for a repository           |
| `--reason records a seeded entry; it needs --seed.`                 | `--reason` without `--seed`                        |
| `--key names the one key --seed records; it needs --seed.`          | `--key` without `--seed`                           |

## The two profiles

`standard` is what Dad asks of every repository. `strict` is the same signals
with tighter numbers: a signal report-only in `standard` may carry a threshold
in `strict`, and a threshold in both may be lower in `strict`.

A project tightens; it never loosens. No flag lowers a threshold, and the only
way past a verdict is a recorded exception in `.agents/source-budgets.json`
carrying a reason and the date it was recorded. Exceptions may move toward the
threshold and never away from it.

Some signals start report-only in `standard` on purpose. `tenant-column-authorization`,
`role-if-ladders`, and `unparsed-boundary-reads` read intent out of syntax, and
a signal that would rather be wrong than quiet earns its threshold in `strict`
only after the corpus shows it quiet on real repositories.

## The three verdicts

Each issue reads `present`, `partial`, or `absent`. There is no fourth, and
nothing is ever at warn: a signal either has a number to be judged against in
this profile, or its line says it has none.

- **`present`** — a signal with a threshold in this profile is over it.
- **`partial`** — no signal is over, and a signal this profile only reports but
  `strict` judges saw something. Dad has already said what the number should
  be and has only declined to hold this profile to it yet.
- **`absent`** — neither.

A signal that is report-only in **both** profiles is information, not evidence,
and moves no verdict. `blast-radius` says how far one change reaches; no count
of reached packages is an illness. A floor is the same: it prints its number,
says `report`, and is judged by the recorded baseline rather than by a verdict.

A signal that ran and found nothing is not a signal that did not run. Only a
failure reads `not measured`, with the reason on the line; an empty reading is
`0 seen`, at the state it earned — `ok` under a threshold, `report` without
one.

## Signals and the fixture corpus

A signal is one file under `packages/foundation/toolbox/src/doctor/signals/`
that names the change it stops in a sentence quoted from `DAD.md`, and every
reading it returns carries evidence a reader can open: the path, the line where
there is one, the name where there is one.

A signal without a fixture does not exist. Each one ships with a case in
`fixtures/daddy-issues/<signal-id>/fixture.json`: a tiny repository written as
a manifest, materialized into a temporary directory by the corpus test, which
asserts that the case trips exactly that signal and that no other signal reads
anything. `doctor-cases` reports a signal that ships without a case; it is
report-only, like `test-count`, because a floor on a count blocked healthy
deletions (removing a feature removed its cases and tests, and the gate called
that a loosening). The corpus test still fails on a signal with no case. It is
also the regression suite for false positives.

### Migrations and the base line

`migrations-edited` and `migrations-out-of-order` judge a branch against a base
line, because a migration is a draft until it reaches the line databases are
built from. The base is `origin/main`, else `main`. A migration the base does
not hold yet may be fixed as often as the branch likes; once the base holds it,
any commit past the base that changes it counts, and a migration a branch adds
must be stamped later than the newest one its directory holds on the base. A
checkout sitting on the base reads zero, because what the base holds was judged
when it landed. With neither ref, both signals read the whole history instead
and print a `note:` under their line saying so, rather than passing quietly.

Commit and file-revision history follows the checkout’s first-parent chain.
A merge is measured against its first parent, so side-branch revisions enter
the reading through the changes the merge actually landed.

### Local hook timing and CI

`hook-runtime` compares the median of the last 20 local samples per hook
with budgets of 10 seconds for commits and 60 seconds for cached pushes.
It reads the ignored `.dads/hook-timings.jsonl` in the checkout. A fresh
checkout has no timings yet. This diagnostic does not gate Git operations.
`ci-without-verify` flags repositories that define a verify script and have
no recognized CI workflow running it.

## `dad doctor explain`

```sh
dad doctor explain anxious-attachment
```

Prints one issue's sentence from the essay, the links to both documents, the
numbered questions from [`daddy-issues.md`](./daddy-issues.md) that specify it,
the signals Dad measures today with the threshold each carries in the selected
profile, and the cure. It reports; it cannot be a gate.

## How a repository seeds and gates

`dad doctor` is a report by default. It describes a repository and exits `0`
whatever it found, which is what makes it safe to run on a codebase that has
adopted nothing.

`dad doctor --gate` judges the same signals against
`.agents/source-budgets.json` and exits `1` when something loosened. A ceiling
may only go down, a floor may only go up, and an entry the file records without
a reason is an error in every mode. `--base <ref>` compares this baseline
against the one at a git ref and fails on every direction of loosening, with one
exception: a floor may fall where its entry's `movedTo` names another key in the
same section and that key rose in the same comparison by at least the fall. That
is a package split with its receipt in the diff, so the comparison names the
move instead of failing on it, and so does the `marks-raised-in-history` signal
over the committed history. A fall with no `movedTo`, a `movedTo` the named key
did not earn, and a removed floor entry all still fail. A signal that cannot answer is a warning
naming the reason, never a confident zero: a repository with no history is not
a repository that raised a mark, and `--update` never deletes a baseline it
could not measure.

When a package is deliberately removed, `--base` can retire only that
package's `invariantsFiles` and `typeTestNegativeCases` entries. The base must
declare the former package name and root and contain its matching package
manifest. The old root and package identity must be absent from the current
tree. The comparison reports each approved retirement.

When the same package name has a replacement root, its named invariant floor
still applies. Record the old type floor, package name, measured replacement
roots, and reason in `.agents/type-proof-transitions.json` before retiring the
old type-test root. Each replacement must have a positive recorded floor met
by its current compiled negative assertions. Global and surviving floors are
held by the same comparison.

A few signals are report-only: `dad doctor` prints them and the gate never
judges them, not even under `--base`, and the history check ignores their
entries. Today those are the `test-count` and `doctor-cases` floors. Counting
tests and cases is useful; refusing a change because the count fell punished
deleting dead code.

A repository adopts the gate in one step:

```sh
dad doctor --seed --today 2026-09-07 --reason "adoption baseline"
dad doctor --gate
```

`--seed` records today's numbers as exceptions, each with the reason and the
date. From then on `--gate` holds them, and `--update` writes back every
downward move so the recorded numbers follow the code. `--key` seeds one entry
rather than all of them, which is how a single exception is added later.

## One command for everything

`npm run checkup` runs every proof this repository holds itself to (the same
set CI runs, through the verify runner's `--full` mode) and then prints this
report over the repository, dated today. The proofs decide the exit code; the
report never does. It is the answer to "is everything still good, and what is
wrong" in one command.

The pre-push hook requires a verification receipt for each commit being
pushed. Use `npm run checkup` when you want the full proof followed by a
diagnosis.

## Adoption

`create-dads` can run Doctor over an existing repository before creating the
isolated project. From a source checkout built with `npm run build:cli`, preview
the plan and diagnosis:

```sh
node packages/foundation/create-dads/bin/create-dads.js /path/to/your/project --existing --yes --dry-run
```

In interactive mode the report comes before the creation prompts. It never fails the creation: a signal that
cannot answer is a line in the report. `--skip-doctor` opts out, and a fresh
target says in one line that there was nothing to read. See the
[`create-dads` README](../packages/foundation/create-dads/README.md).

## What it refuses to do

- No auto-fix. Splitting a file or moving a type is a decision about meaning.
- No loosening. No flag lowers a threshold; exceptions are recorded with a
  reason and a date, and may only move toward the threshold.
- No clock. Every date arrives through `--today`.
- No network by default. A signal that would have to reach out reads
  `not measured (offline)` until a run is told it may.
- No failing report. Only the gate exits nonzero.

## The seventeen issues

Every signal reported under each issue, in the order the report prints them. A
signal cross-listed under a second issue is measured once and named under both.

| Issue                                                                                                  | Signals                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Daddy issues](./daddy-issues.md#daddy-issues)                                                         | `eslint-disables`, `ts-suppressions`, `explicit-any`, `type-assertions`, `non-null-assertions`                                                                                                                                                                    |
| [Anxious attachment](./daddy-issues.md#anxious-attachment)                                             | `kind-inversions`, `duplicated-helpers`, `vendor-outside-adapter`, `blast-radius`, `vendor-types-in-surface`, `copied-types`                                                                                                                                      |
| [Avoidant attachment](./daddy-issues.md#avoidant-attachment)                                           | `docs-conformance-packages`, `readme-missing`, `readme-nonconformant`, `invariants-files`, `undocumented-exports`, `routes-without-schema`, `routes-without-access`, `responses-outside-envelope`                                                                 |
| [Disorganized attachment](./daddy-issues.md#disorganized-attachment)                                   | `interface-type-mix`, `unparsed-boundary-reads`, `duplicate-wire-schemas`, `assertions-in-tests`, `jsonb-without-schema`, `migrations-out-of-order`                                                                                                               |
| [Enmeshment](./daddy-issues.md#enmeshment)                                                             | `files-over-ceiling`, `test-files-over-ceiling`, `clippy-allows`, `rust-inline-tests`, `barrel-impurity`, `functions-over-ceiling`, `god-classes`, `fan-out`, `intra-package-cycles`                                                                              |
| [You are looking for a father figure](./daddy-issues.md#you-are-looking-for-a-father-figure)           | `framework-in-core`, `vendor-named-domain`, `stale-docs`, `scripture`, `hardcoded-ui-copy`                                                                                                                                                                        |
| [You repeat the cycle](./daddy-issues.md#you-repeat-the-cycle)                                         | `junk-drawer-directories`, `tenant-column-authorization`, `role-if-ladders`, `per-feature-authorization`, `console-in-production`, `domain-in-apps`, `routes-without-access`                                                                                      |
| [You let the babysitter raise them](./daddy-issues.md#you-let-the-babysitter-raise-them)               | `agent-entrypoint-missing`, `entrypoint-over-budget`, `agent-hooks-unwired`, `orphan-paths`                                                                                                                                                                       |
| [People-pleasing](./daddy-issues.md#people-pleasing)                                                   | `multi-shape-responses`, `optional-creep`, `deprecated-still-consumed`, `forbidden-403`, `denial-with-body`, `loose-contract-objects`, `raw-errors-in-ui`                                                                                                         |
| [You stay with people who cannot meet you](./daddy-issues.md#you-stay-with-people-who-cannot-meet-you) | `controlling-peers`, `transport-at-root`, `shared-database`, `shared-catchall`                                                                                                                                                                                    |
| [Commitment issues](./daddy-issues.md#commitment-issues)                                               | `test-count`, `type-test-negative-cases`, `soundness-cases`, `todo-check-permission`, `single-implementer-abstractions`, `skipped-tests`, `mutations-without-ownership`, `denial-tests-zero`, `todo-age`, `access-without-denial-test`, `sequential-authz-writes` |
| [Gaslighting](./daddy-issues.md#gaslighting)                                                           | `baseline-entries-without-reason`, `exempt-globs`, `suppressions-without-description`, `marks-raised-in-history`, `migrations-edited`, `generated-tables-hand-edited`, `generated-access-hand-edited`                                                             |
| [The silent treatment](./daddy-issues.md#the-silent-treatment)                                         | `suppressed-violations`, `unused-suppressions`, `suppression-age`                                                                                                                                                                                                 |
| [Failure to launch](./daddy-issues.md#failure-to-launch)                                               | `packages-without-surface`, `strict-profile-absent`, `logic-in-controllers`, `lists-without-filter`, `reorganization-churn`                                                                                                                                       |
| [“It’s not you. It’s my boundaries.”](./daddy-issues.md#its-not-you-its-my-boundaries)                 | `lint-rules`, `ci-without-verify`, `rules-at-warn`, `compiler-flags-off`, `no-verify-in-scripts`, `force-push-in-workflows`, `kinds-undeclared`, `hooks-not-wired`, `rows-sent-whole`                                                                             |
| [The paper wall](./daddy-issues.md#the-paper-wall)                                                     | `wrapper-without-conformance`, `vendor-types-in-surface`, `single-implementer-abstractions`, `no-in-memory-provider`, `provider-chosen-outside-root`                                                                                                              |
| [Dad has issues too](./daddy-issues.md#dad-has-issues-too)                                             | `doctor-cases`, `rules-at-warn`, `guards-fail-closed`, `hook-runtime`, `marks-raised-in-history`, `stagnant-debt`, `nondeterministic-generated-files`                                                                                                             |

Each issue's definition, its numbered test, and its cure are in
[`daddy-issues.md`](./daddy-issues.md); the essay behind them is
[`DAD.md`](../DAD.md).
