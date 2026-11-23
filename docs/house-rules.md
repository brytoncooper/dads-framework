# House rules

The rules this repository holds itself to, and the gates that hold them. Every
rule here is enforced by a program: nothing on this page depends on a reviewer
remembering it. Two kinds of rule appear. A **gate** is locked at zero — the
build fails the first time anything trips it. A **ratchet** records what is
wrong today and refuses to let it get worse.

Checks run at several scopes. Edit guards and pre-commit checks catch local
and staged-file issues. Push and CI verify wider changes. The
[execution table](#where-the-rules-run) shows which checks run at each stage.
After a source change, run `dad test:recommend --changed` to find focused
proof, then `dad verify --changed` to record the result.

## Gates

### Compiler

[`tsconfig.base.json`](../tsconfig.base.json) is the only place strictness is
declared; every package extends it.

| Option                               | What it stops                                                    |
| ------------------------------------ | ---------------------------------------------------------------- |
| `strict`                             | the whole family: implicit `any`, unchecked `null`, loose `this` |
| `noUncheckedIndexedAccess`           | an index read that pretends it cannot miss                       |
| `exactOptionalPropertyTypes`         | `undefined` smuggled in as a present-but-empty property          |
| `noImplicitOverride`                 | a method that shadows a base without saying so                   |
| `noImplicitReturns`                  | a branch that falls off the end of a function that returns       |
| `noFallthroughCasesInSwitch`         | a `case` that runs the next one by accident                      |
| `noPropertyAccessFromIndexSignature` | a typo read as a valid dotted key                                |
| `useUnknownInCatchVariables`         | a caught error treated as anything you like                      |
| `verbatimModuleSyntax`               | a type import that survives into emitted JavaScript              |

`npm run typecheck` builds the workspace and compiles the test files.

**Test files.** Every package `tsconfig.json` ends with
`"exclude": ["src/**/*.test.ts"]`, so a test never reaches `dist`. That
exclusion also meant `tsc -b` never opened one: ESLint's typed rules report
rule violations rather than type errors, and Vitest strips types instead of
checking them, so nothing compiled a test file at all. A test could call a
function with the wrong arguments, or assert against a shape the production
type no longer has, and every gate stayed green.
[`scripts/checks/check-test-types.mjs`](../scripts/checks/check-test-types.mjs)
closes that. Each package carries a sibling `tsconfig.tests.json` that extends
its own `tsconfig.json` — the same `strict` family, the same `lib`, the same
`target` — drops the exclusion, and adds `noEmit` with `composite: false` so
the run writes nothing and no `.tsbuildinfo` collides with `tsc -b`. It adds
one option the packages do not set: `types: ["node"]`, because every test runs
under Vitest on Node. The check pairs packages and projects both ways before it
compiles anything — a package that owns test files must declare one, and a
package that owns none must not keep a stale one — so a new package is in the
gate the day it is written rather than the day someone remembers to list it.

### Lint: TypeScript

[`eslint.config.js`](../eslint.config.js) applies five scopes. Every rule in
every scope is at `error`; nothing is at `warn`.

| Scope      | Files                                                                      | Adds                                                |
| ---------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| base       | `**/*.ts`                                                                  | `strictTypeChecked`, no `any`, no `!`, type imports |
| scripts    | `**/*.{js,mjs}`                                                            | type-checked rules off, `no-console` off            |
| production | `packages/*/*/src/**/*.ts`, `apps/*/src/**/*.ts`, `fixtures/*/src/**/*.ts` | house rules, function ceilings, `no-console`        |
| tests      | `**/*.test.ts`                                                             | house rules, no focused tests                       |
| type tests | `packages/*/*/type-tests/**/*.ts`                                          | house rules                                         |

The production scope excludes `**/*.test.ts` and `**/*.generated.ts`.

**House rules** — the ten rules every hand-written TypeScript file obeys. They
close the escape hatches: no assertion rewrites a type, no comment silences the
compiler without a stated reason, and no value reaches a string or a `throw`
without the type system agreeing it belongs there.

- `consistent-type-assertions` with `assertionStyle: "never"` — no `as`.
- `no-unsafe-type-assertion` — the assertions a plugin cannot see as `as`.
- `ban-ts-comment` — `@ts-ignore` and `@ts-nocheck` are banned outright;
  `@ts-expect-error` needs a description of at least ten characters.
- `consistent-type-definitions: "type"` — `type`, not `interface`.
- `switch-exhaustiveness-check` — every union member handled, a `default`
  required on anything that is not a union.
- `prefer-readonly` — a private field never reassigned is declared `readonly`.
- `restrict-plus-operands` and `restrict-template-expressions` — nothing
  reaches `+` or a template literal by coercion. Numbers are the one exception.
- `return-await` in `error-handling-correctness-only` mode — a `return` inside
  `try` is awaited, so the `catch` runs.
- `only-throw-error` — you throw an `Error`, not a string.

**Function ceilings** — production only; a test may enumerate as many cases as
it needs.

| Rule                   | Limit |
| ---------------------- | ----: |
| `complexity`           |    10 |
| `max-depth`            |     3 |
| `max-statements`       |    20 |
| `max-nested-callbacks` |     2 |

**Focused tests** — `it.only`, `it.skip`, `it.todo` and their `test`/`describe`
forms are banned by `no-restricted-syntax` in test files. An environment gate is
`it.skipIf(condition)`, which still names the test and still reports it.

**Suppressions.** [`eslint-suppressions.json`](../eslint-suppressions.json)
records the violations that existed when these rules landed: 126 violations of
8 rules across 55 files. It is written and read by ESLint itself, never by hand,
and it is Prettier-ignored so a rewrite cannot leave the tree dirty. A
suppression is per rule and per file, not per line, so the file it lists is held
by its ratchet mark rather than by the suppression. Fixing violations and
running `npm run lint:prune` removes the entries that are no longer needed;
`npm run verify` never regenerates them.

The kit import of 2026-11-19 added 266 violations of 18 rules across 56 files,
recorded with the owner's approval so the import could land as one change. They
are burned down by fixing the code, and `npm run lint:prune` removes each entry
as its file comes clean. Removing a legacy `pg` type augmentation that had
replaced the driver's types across the lint program cleared most of them the
same day.

### Lint: Rust

[`Cargo.toml`](../Cargo.toml) declares the workspace lints; every crate opts in
with `[lints] workspace = true`.

| Lint                                           | Level    |
| ---------------------------------------------- | -------- |
| `clippy::unwrap_used`, `expect_used`, `panic`  | `deny`   |
| `clippy::unreachable`, `todo`, `unimplemented` | `deny`   |
| `clippy::too_many_lines`                       | `deny`   |
| `unsafe_code`                                  | `forbid` |

[`clippy.toml`](../clippy.toml) sets `too-many-lines-threshold = 100`. Raising
that number is not how a long function passes.

A panic path that survives review is first expressed as a typed error. The only
allowances are `#![allow(...)]` at the head of a `#[cfg(test)]` module, and the
`#[allow(clippy::too_many_lines)]` marks on production functions — each one
carries a comment naming the split that removes it, and each one is counted by
the `clippy-allows` signal, which the ratchet gates at zero.

### Boundaries

`node scripts/checks/check-dependency-boundaries.mjs` holds three surfaces to
the one declaration in [`dads.project.json`](../dads.project.json).

| Gate                    | Question                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `imports`               | does any production source file reach a package `allowedDependencies` omits?               |
| `declared-dependencies` | do `allowedDependencies` and `package.json` say the same thing, both ways?                 |
| `public-surface`        | does an emitted `.d.ts` name a type from outside the package and its allowed dependencies? |

`devDependencies` are outside all three: they are the repository's build and
test tools, not the package's edges. A package with no `dist/` is skipped by the
surface gate rather than failed, so the check runs before a build.

**Kinds.** Every package declares a `kind`, and the kind says what it may know
about. The matrix is the whole rule.

| Kind          | What it is                                                       | May depend on                        |
| ------------- | ---------------------------------------------------------------- | ------------------------------------ |
| `core`        | the layer everything else is written against                     | `core`, `artifact`                   |
| `adapter`     | binds one vendor to `core`                                       | `core`, its declared third party     |
| `binding`     | binds one more library to an adapter it names                    | `core`, that adapter, its library    |
| `edge`        | composes core packages into a boundary                           | `core`, `edge`                       |
| `profile`     | assembles the layers into a strictness posture                   | `core`, `adapter`, `binding`, `edge` |
| `tooling`     | operates on the framework                                        | `core`, `tooling`, `artifact`        |
| `composition` | an application or a fixture                                      | anything                             |
| `artifact`    | a distribution of something else: one platform's compiled binary | nothing                              |

An `artifact` is not an adapter: a native binary is `core`'s own output for one
platform, not a vendor being bound. Only `core`, `tooling`, and `composition`
may reach one, and an artifact reaches nothing.

A `binding` is not an adapter either: it binds a library to an adapter rather
than to `core` (a query builder over a storage adapter's plan). It reaches the
one adapter it names and nothing else outside `core`, so replacing the library
is deleting one package and adding another; nothing above the seam moves.

Forbidden edges are counted by the `kind-inversions` signal, gated at zero. A
package with a missing or unrecognized `kind` fails the reading rather than
counting as zero.

**Barrels.** A package's `src/index.ts` re-exports; it does not implement.
Statements that are not `export ... from` are counted by the `barrel-impurity`
signal, parsed with the TypeScript API rather than matched with a regular
expression.

### Public surface

`npm run api-report` writes `packages/<group>/<name>/api-report.md` for every
package that declares `publishConfig`: one line per export, with the declaration
text as the compiler emitted it. A change to the surface **is** the diff.
`npm run api-report:check` writes nothing and fails with that diff; it runs
inside `npm run verify`, after the `build` step has emitted `dist/`.

Each report records the package's `published` flag from `dads.project.json`.

| `published` | What drift means                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `false`     | regenerate the report in the same change. Nothing is installed yet, so nothing can break.                                                                                                         |
| `true`      | a **removed or narrowed** line is a breaking change: it needs a major version bump and a `CHANGELOG.md` entry naming the export. An added line is additive and only needs the regenerated report. |

The flag may only move `false` to `true`. Nothing may move it back.

### Invariants

`node scripts/checks/check-invariants.mjs` holds every citation in every
`packages/<group>/<name>/INVARIANTS.md` to the code it names. An entry is a
promise with a receipt — `enforced by <file>#<symbol>`, `proven by <file>
"<test name>"` — and the receipt is worth exactly its accuracy. Nothing else
reads these files, so a renamed function or a deleted test leaves the entry
behind, still naming a symbol that is gone.

| Citation                 | Question                                                                       |
| ------------------------ | ------------------------------------------------------------------------------ |
| `<file>`                 | does the file exist, package-relative or repository-relative?                  |
| `<file>#<symbol>`        | does that file declare the symbol, at any depth, exported or not?              |
| `<file>` `"<test name>"` | does that file give a test that name, literally or through its title template? |

Symbols come from the TypeScript parser, never from a pattern over the text;
a Rust citation is a `path#fn` and resolves against the `fn`, `struct`,
`enum`, and `trait` the file declares. Every entry must carry an `enforced by`
clause naming at least one file; `proven by` is optional and checked whenever
it is written. A bullet that does not parse fails and names its file, its
entry, and its text, rather than being skipped. Inside a clause, a backticked
span that is not a path and not an identifier is prose, so `413 BODY_TOO_LARGE`
and `npm run verify:http` cost nothing — but a bare backticked word in an
`enforced by` clause is read as a symbol, so a SQL keyword or a crate name
there is written without the backticks. `--json` prints the same result for a
machine.

## The ratchet

The ratchet is `dad doctor --gate`, the product this repository ships, run
through [`scripts/checks/check-source-budgets.mjs`](../scripts/checks/check-source-budgets.mjs) —
a wrapper that keeps the path every hook, guard and workflow already calls,
translates its flags, and passes the exit code and the output through. No flags
at all mean `--gate`. There is no private engine any more: the states, the
baseline format and the pawl live in the toolbox as `src/doctor/doctor-gate*.ts`,
so an adopting repository gets exactly what this one is held to.

It holds a single opinion: a number that may not grow (a **ceiling**) or may not
shrink (a **floor**), a threshold every key is expected to reach, and a baseline
of recorded exceptions that may only ever move toward that threshold.

The baseline is [`.agents/source-budgets.json`](../.agents/source-budgets.json),
in the format the engine that preceded the doctor wrote — the migration changed
no byte of it. Every entry carries a `reason`. Local writes are only ever in the
direction of the threshold: `--update` lowers marks, deletes finished ceiling
entries, and raises floors. It never adds a ceiling entry and never raises a
mark. An upward edit is possible by hand and is caught by `--base`, which
compares the baseline against the one at a git ref. That comparison, not trust,
is the pawl.

Counted lines are **non-blank, non-comment**. Reformatting cannot move a number,
and neither can adding documentation.

### Signals

The gate judges every signal the doctor ships that the active profile gives a
number to — 59 ceilings and 5 floors under `standard` today — and leaves the
report-only ones to `dad doctor`. `test-count` and `doctor-cases` are
report-only since 2026-11-19: floors on test counts blocked healthy deletions,
so they are shown and never held. `dad doctor explain <issue-id>` prints the
signals under one issue with the threshold each profile holds them to, and
`npm run budgets:report` prints every key that is listed or over.

A signal is recorded in the baseline under its `measure` name where it has one
and its id otherwise. The sixteen sections seeded on 2026-09-04 therefore keep
the names they were written with, and this table is how a section maps onto the
signal that now measures it.

| Baseline section                | Signal                      | Direction | Threshold | What it counts                                                      |
| ------------------------------- | --------------------------- | --------- | --------: | ------------------------------------------------------------------- |
| `fileLines`                     | `files-over-ceiling`        | ceiling   |       400 | counted lines per `.ts`, `.rs`, `.mjs`, `.js` file                  |
| `testFileLines`                 | `test-files-over-ceiling`   | ceiling   |       600 | counted lines per test file                                         |
| `rustInlineTests`               | `rust-inline-tests`         | ceiling   |         0 | `#[cfg(test)] mod tests` in a file that is not `tests.rs`           |
| `clippyAllows`                  | `clippy-allows`             | ceiling   |         0 | `#[allow(clippy::` marks in production Rust                         |
| `eslintDisables`                | `eslint-disables`           | ceiling   |         0 | `eslint-disable` comments in TypeScript                             |
| `tsExpectErrorOutsideTypeTests` | `ts-suppressions`           | ceiling   |         0 | `@ts-expect-error` outside a `type-tests/` directory                |
| `barrelImpurity`                | `barrel-impurity`           | ceiling   |         0 | statements in a package barrel that are not `export ... from`       |
| `kindMatrixViolations`          | `kind-inversions`           | ceiling   |         0 | workspace edges the kind matrix forbids                             |
| `duplicatedHelpers`             | `duplicated-helpers`        | ceiling   |         1 | production files per package that declare the same function name    |
| `docsConformancePackages`       | `docs-conformance-packages` | floor     |         — | packages listed in `docs/readme-conformance.json`                   |
| `invariantsFiles`               | `invariants-files`          | floor     |         — | packages with an `INVARIANTS.md`, one floor per package             |
| `soundnessCases`                | `soundness-cases`           | floor     |         — | cases in the sealed soundness corpus                                |
| `typeTestNegativeCases`         | `type-test-negative-cases`  | floor     |         — | `@ts-expect-error` assertions per package `type-tests/` directory   |
| `lintRules`                     | `lint-rules`                | floor     |         — | error-level rules `eslint --print-config` resolves per config scope |

Ceilings reward deleting code, so the floors are the net underneath them:
negative type tests, soundness cases, invariants files, documented packages,
and lint rules may grow and may never quietly shrink. Test and doctor-case
counts are reported, not floored: a floor on them blocked healthy deletions. A
floor that measures nothing at all is reported as _not measured_ and skipped, rather than read as a count of zero. So is a signal that cannot answer:
a workspace with no git history, or a run with no `--today` for the two signals
that measure days, says so as a warning and fails nothing, and its recorded
entries are left exactly where they are.

### The exceptions this repository records

The ceiling keys below are recorded rather than fixed, each with a reason and
the date it was recorded. `npm run budgets:report` lists them beside the
floors.

| Section                   | Key                                                            | Why                                                                                                     |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `marks-raised-in-history` | `ceilings/fileLines/crates/dads-testing-javascript/src/lib.rs` | commit `5cb8c3d` raised a mark before the pawl compared against a base ref; history cannot change       |
| `marks-raised-in-history` | `floors/docsConformancePackages/packages`                      | the file-suffix grammar was removed on 2026-11-19 (reverts of #33–#36); the floor fell with the feature |

The kit import of 2026-11-19 seeded 135 more ceiling keys across 15 sections,
each with the reason `imported from the origin product's kits on 2026-11-19`. They are not
listed one by one: `npm run budgets:report` shows them, and they are burned down
by fixing the imported code, with `npm run budgets:update` deleting each entry as
it reaches its threshold.

The [contract kit](./validation.md) owns shared Zod contracts. HTTP route
cards declare their own request and response shapes.

`@dads-framework/testing/vitest` was listed until 2026-09-07, when the resolver
it wrapped `tsconfig-paths` for moved into `@dads-framework/testing/path-aliases` and
the vendor was dropped. That core owns the alias rules, a file system port, and
the conformance suite both of its providers run — `nodeFileSystem` and
`inMemoryFileSystem` — so the plugin is an adapter over a boundary that holds
rather than a wrapper over a vendor.

The [request transport](../packages/client/README.md)
couples requests and responses to contract schemas. The [HTTP kit](./http-hosting.md)
uses the same route pipeline for socket and injection tests.

A split like those moves tests out of one package and into another, which lowers
a floor. That is recorded rather than forgiven: the entry that fell carries
`movedTo`, naming the key its count went to, and the same change has to raise
that key by at least the fall. It is a receipt, not a waiver — the count still
has to exist somewhere.

For two providers that implement the same capability inside one adapter
package, its `package.json` can declare `dadsConformance`. Set `capability`
to the behavior the suite covers, `suite` to its package-relative source file,
and `law` to its exported suite registration function. Each item in `runs`
names a package-relative `test` and a `provider` with the module and export it
uses. The named suite takes a provider factory and law registration callback.
Tests must call that suite directly with the actual provider and run its laws
with Vitest. Doctor checks those registrations and distinct provider identities.
The verification command still has to run the tests.

### Baseline states

A ceiling key, in the order the states are decided:

| Key state                       | `check`                                 | `--update` |
| ------------------------------- | --------------------------------------- | ---------- |
| unlisted, at or under threshold | pass                                    | pass       |
| unlisted, over threshold        | **error** — split it                    | error      |
| listed, at or under threshold   | **error** — entry can be deleted        | deleted    |
| listed, above its mark          | **error** — the ratchet only turns down | error      |
| listed, at its mark             | warning                                 | warning    |
| listed, below its mark          | **error** — mark can be lowered         | lowered    |
| listed, nothing measured        | **error** — stale entry                 | deleted    |

A floor key:

| Key state                                                                                        | `check`                                                       | `--update`               |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------ |
| unlisted, measured                                                                               | pass                                                          | recorded, with `--today` |
| listed, below its floor                                                                          | **error** — restore it                                        | error                    |
| listed, at its floor                                                                             | pass                                                          | pass                     |
| listed, above its floor                                                                          | **error** — floor can be raised                               | raised                   |
| listed, nothing measured                                                                         | **error** — recorded by the floor but nothing measures it now | error                    |
| listed, below the base's floor, `movedTo` declared and the destination rose by at least the fall | pass (the pawl), and 0 from the history signal                | pass, receipt kept       |
| listed, `movedTo` naming its own key or a key this section does not record                       | **error** — nobody can check the arithmetic                   | error                    |

A floor entry is never deleted by a tool. Deleting one is a loosening, so
`--base` fails on a removal as well as on a fall. A floor may still **move**:
where its entry carries `movedTo`, naming another key in the same section that
rose in the same diff by at least the fall, the fall is a package split with
its receipt in the change that made it, and `--base` names the move rather than
failing on it. The rule reads the arithmetic, never the sentence beside it: the
`reason` still has to say what moved and when, but a fall with no `movedTo`, a
`movedTo` the destination did not earn, and a removed entry are the loosenings
they always were. The receipt stays on the entry afterwards, where a later diff
that does not fall on that key ignores it, and no tool ever writes one — only
whoever made the split can say where the count went.

An entry with no `reason` is an error in every mode, including `--base`.

### Modes

| Mode            | What it does                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------- |
| _(default)_     | the wrapper's no-flag run, which is `--gate`                                                        |
| `--gate`        | judge every gated signal; exit 1 on any error                                                       |
| `--update`      | apply every downward move — lower marks, delete finished entries, raise floors                      |
| `--file <path>` | ceilings for one path, measured whether or not git has seen it                                      |
| `--base <ref>`  | compare this baseline against the one at `<ref>`; fail on any loosening, and name a declared move   |
| `--seed`        | record an exception for a key that is over and unlisted; needs `--today`, takes `--reason`, `--key` |
| `--report`      | list every listed or over-threshold key, largest first                                              |
| `--json`        | machine-readable output; combines with any mode                                                     |

`--seed` and `--update` are exclusive; `--base` only reads, so it combines with
neither; `--file` is one path and combines with neither `--base` nor `--seed`.
`--reason` and `--key` belong to `--seed` and are refused without it. Every mode
prints JSON on `--json` and human lines otherwise, exits 0 when clean and 1 on
violations. Dates come only from `--today`; nothing reads the clock, so a run is
reproducible.

`--seed` only ever adds. It records the keys that are over and unlisted, with
the reason it was given and the date it was given, and it never touches an entry
the baseline already holds — seeding twice cannot loosen anything. `--key`
narrows it to one key, which is how an exception gets a reason of its own rather
than a reason shared with three others.

### Fix commands

| Situation                                             | What to run              |
| ----------------------------------------------------- | ------------------------ |
| you split a file, or deleted an allow, or added tests | `npm run budgets:update` |
| you want to see what is listed and how far over       | `npm run budgets:report` |
| you fixed lint violations in a suppressed file        | `npm run lint:prune`     |
| you changed a package's exports                       | `npm run api-report`     |
| you want the whole gate                               | `npm run verify`         |

`--update` is not a way to make a failure go away. It records improvements you
already made. A new offender has no update path: the answer is a split.

## Where the rules run

| When    | Where                                              | What runs                                                                                                                                                                                         |
| ------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit    | [Agent guards](../scripts/agent-guards/README.md)  | Format, lint and run the per-file ratchet. Ask before protected edits and deny hook bypasses and force-pushes to main.                                                                            |
| Commit  | [Pre-commit](../.githooks/pre-commit)              | Staged-file formatting, lint and the per-file ratchet. The target is 10 seconds.                                                                                                                  |
| Push    | [Pre-push](../.githooks/pre-push)                  | Require a passing receipt for the commit at each pushed ref. Run the verify graph with its local step cache when proof is missing. The target is 60 seconds on the cached path.                   |
| CI      | [Verify workflow](../.github/workflows/verify.yml) | Run the verify graph and base-relative ratchet, adoption proofs, Rust checks, soundness corpus shards, and combined release evidence. The runners divide the proof without reusing prior results. |
| Release | `npm run verify:release`                           | Run the full uncached graph. The publish lifecycle requires that receipt before publishing from the checkout.                                                                                     |

`npm run prepare` wires the tracked hooks (`git config core.hooksPath
.githooks`), so `npm ci` installs them. A missing edit guard can fail open.
Malformed push input, unknown verification inputs, or a missing receipt after
the run stops the push. Agents run `dad verify --changed` before declaring work
done.

### Proof receipts

A passing `npm run verify` on a clean committed checkout records its commit, tree, resolved comparison base,
verification steps and date under `dads/verify-receipts` in Git's common
directory. Separate worktrees can reuse it. The receipt also binds the
fingerprint of ignored inputs, Node version, platform, CI mode and the
verification environment used by the step cache. A changed checkout can still run checks, but earns no receipt.

The push hook reads the refs from Git. Tags that point to commits use the
peeled commit. For a different or dirty checkout with no matching receipt, the
hook installs dependencies and verifies in a temporary detached worktree. An
older tree without receipt support needs the verifier before it can pass the
hook.

`npm run verify:release` requires a clean committed checkout and runs
`--full --no-cache`. It includes adoption, Rust, soundness and release-evidence
checks. `npm publish` from a package checkout checks for this full receipt.
Normal verify receipts can cover pushes.

`npm run checkup` runs the full graph and follows it with a dated doctor's
report. The report leaves the exit code unchanged.

## The verify runner

`npm run verify` is `node scripts/verify.mjs`. It runs the eighteen proofs
the old `&&` chain ran plus the test-file typecheck and the invariants gate, arranged as a dependency graph instead of a line, so
the proofs that do not feed each other run at the same time. In CI every step
runs on every invocation. Locally, a step whose inputs are unchanged since it
last passed is skipped ([the local cache](#the-local-cache)). The graph itself
removes only the second identical `tsc -b`, which the chain opened once for
`lint` and once for `typecheck`.

[`scripts/verify-graph.mjs`](../scripts/verify-graph.mjs) is the whole
declaration — one entry per step with its command, what it waits for, and the
cores it keeps busy. Three groups:

| Waits for | Steps                                                                                                   | Why                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| nothing   | `format`, `private-references`, `build`, `markdown-links`, `script-tests`, `instruction-budgets`        | they read tracked source, never build output                                                                  |
| `build`   | `eslint`, `api-report`, `docs`, `test`, `workbench-client`, `dependency-boundaries`, `agent-benchmarks` | each one resolves a package through its emitted `dist/`                                                       |
| both      | `source-budgets`                                                                                        | the gate is `dad doctor --gate`, which needs `dist/`, and its `test-count` floor reads the Vitest JSON report |

`dependency-boundaries` is in the second group on purpose: its `public-surface`
gate _skips_ a package that has no `dist/`, so waiting for the build is what
keeps it a gate rather than a pass.

`--full` appends the proofs CI runs in its other jobs: `adoption` after the
build; `rust-format`, `rust-lint`, `rust-test`, and `engine` as one chain,
because cargo serializes on its target lock; `corpus` after the engine, on the
debug binary CI also uses; and `release-evidence` after the corpus. Each of
those already spreads itself across the machine, so each is weight `"all"`.

### The budget

Each step declares the CPU it keeps busy, measured: `1` for a single-threaded
process, `2` for one that measured between one and two cores, and `"all"` for a
tool that owns a worker pool — the compiler and Vitest. The runner keeps the
sum of the running weights inside a slot budget. An `"all"` step is exclusive
against another `"all"` step and books half the budget against everything else,
so the cheap checks keep draining beside it.

The budget is one slot per idle core and per free gibibyte, whichever is
smaller: `floor(cores x idle - 1)` against `floor((available - 1 GiB) / 1 GiB)`,
never below one. The run prints the receipt — both numbers, which one bound,
and where the reading came from.

| Control             | What it does                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| _(none)_            | samples the host and prints why it chose the budget it chose                                            |
| `--jobs <n>`        | a fixed budget                                                                                          |
| `DADS_VERIFY_JOBS`  | `--jobs` for CI                                                                                         |
| `--serial`          | one step at a time, in the order the old chain ran them                                                 |
| `--full`            | adds the adoption proofs, the Rust gates, the engine build, the corpus, and the release evidence        |
| `--with-doctor`     | after the proofs, prints `dad doctor` over this repository, dated today; the report moves no exit code  |
| `--checkup`         | `--full --with-doctor`                                                                                  |
| `--fail-fast`       | starts nothing new after the first failure; never the default, so a run shows every failure it can find |
| `--no-fail-fast`    | keeps scheduling unrelated steps after a failure                                                        |
| `--no-cache`        | runs every step and neither reads nor writes the local step cache                                       |
| `--require-receipt` | requires a clean committed checkout and a newly recorded proof receipt                                  |

### What a run says

One line when a step starts, one when it finishes with its duration and status,
in the order the events happen. A failing step prints its whole stdout and
stderr immediately, delimited. The closing block is every step with its
duration and status, the longest chain of steps through the graph, the budget
receipt, and the wall clock. The exit code is the first failure's exit code.

A failure does not stop work already running. It blocks the steps that read the
failed step's output — reported as `blocked`, not silently dropped — and leaves
everything else alone. `--fail-fast` starts nothing further at all.

Measured on a 15-core host, 2026-09-06: 31 s with `--serial`, 13 s as a graph.
The floor is the chain `build -> test -> source-budgets`, which the runner
prints as the critical path; no budget makes a run shorter than that.

### The local cache

A step is skipped when its inputs are exactly the inputs of a run in which it
passed. The record of that pass lives in `.dads/verify-cache/`, which is
gitignored and never leaves the machine. A failure is never recorded, so a red
step runs every time.

The inputs are a fingerprint of content, not timestamps
([`scripts/verify-cache.mjs`](../scripts/verify-cache.mjs)): the Git tree of the
checkout as it is on disk, uncommitted and untracked files included, taken
through a throwaway index; the hash of every gitignored file except build
output (`node_modules`, `dist`, `.dads`, `target`, `coverage`,
`*.tsbuildinfo`); the step's command; the Node version and platform; and the
`VITEST*`, `DADS*`, `NODE_OPTIONS`, `NODE_ENV`, `TZ` and Rust
toolchain overrides. Each step
reads one of two scopes, declared in
[`scripts/verify-cache-scopes.mjs`](../scripts/verify-cache-scopes.mjs):

| Scope     | Inputs                                                                                                                                          | Steps                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `tree`    | the whole checkout, ignored files included; any change anywhere reruns the step                                                                 | every repo-wide check: `format`, `private-references`, `eslint`, budgets |
| `package` | the package, every workspace package it reaches through `package.json` or `tsconfig.json` references, the root files (lockfile, shared configs) | inside `test` and `test-types`                                           |

`test` and `test-types` cache one package at a time themselves:
[`scripts/verify-test-step.mjs`](../scripts/verify-test-step.mjs) runs Vitest
only over the packages whose scope changed and rebuilds the full JSON report
from this run plus the recorded suites, so the `test-count` floor still sees
every package; `check-test-types.mjs` compiles only the projects whose scope
changed. A step that names no scope is never skipped; `build` names none on
purpose, because `tsc -b` is incremental already and the steps after it need
its `dist`.

It fails safe. A package whose source names a relative path outside itself,
calls `process.cwd()`, or speaks of a repository root is keyed on the whole
tree, and so is one whose manifest cannot be read. No fingerprint (not a Git
checkout, an ignored directory over 5,000 files) means no cache for the run.
The fingerprint is taken again when the run ends; if the checkout moved while
the steps ran, everything the run recorded is thrown away.

There is no cache at all, no read and no write, when `CI` is set, with
`--no-cache`, or with `--full`. `dad verify` follows the same switch: with `CI`
set or `--no-cache` it looks up no receipt. The closing block names every step
that was cached, every step that was partly cached, and why the cache was off
when it was.

Its limits: build output is trusted to come from the tree, a dependency
installed outside the lockfile (`npm link`) is invisible, and environment
variables other than the ones above are not part of the key. `--no-cache`
answers any doubt.

## What Dad does for you

Dad wrote down what the house already looks like, so nobody has to argue about
it from memory. The 2,900-line file is not a crime — it is a mark on the
doorframe, and the only direction the pencil moves is down.

## Daddy issues this prevents

A codebase where every rule is a preference, so the tired version of you at 4pm
on a Friday is the one who decides. The measures do not get tired, and they do
not care whose file it is.

## What it refuses to do

- **It does not auto-fix your code.** The hooks run the mechanical formatters —
  Prettier, `eslint --fix`, `rustfmt` — and nothing else. Splitting a file is a
  decision about meaning, and a tool that guessed at it would be worse than the
  long file.
- **It does not raise a mark.** No mode adds a ceiling entry or raises one, and
  `--update` writes only downward. Recording a new offender takes `--seed`,
  which is run once, or a hand edit, which `--base` fails.
- **It does not budget prose.** Comments and blank lines are not counted, so
  documenting a function is free and a file cannot be shrunk by deleting the
  explanation. Markdown has no ceiling at all;
  [`.agents/instruction-budgets.json`](../.agents/instruction-budgets.json)
  governs agent instructions, and that is a separate rule with a separate
  reason.
- **It does not accept an exception without a reason.** Every baseline entry
  carries one, and an entry that loses it fails the gate.
