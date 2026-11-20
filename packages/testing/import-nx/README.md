# `@dads-framework/testing-import-nx`

Two ways to reach Dads testing from an Nx repository: a live adapter that plans
and runs Nx targets in place, and a one-way command that converts a clean Nx
workspace into a standalone Dads manifest. The testing facade and the native
impact engine stay independent of Nx either way.

## What Dad does for you

Dad will meet your repository where it is and still tell you what he could not
prove. Every target he registers carries a reason, every target he excludes
carries a reason, and the ones Nx alone can explain are selected every time
rather than guessed at.

## Try it

```sh
dad-test-nx plan /path/to/workspace --base HEAD --json
dad-test-nx run /path/to/workspace --base HEAD --targets test,lint --json
```

Without `--json`, each call prints two lines:

```
R verification targets registered; E targets excluded.
S selected, U proven unaffected. Nx owns prerequisite execution; see --json for coverage reasons.
```

## Commands

### `dad-test-nx plan|run [workspace]`

`plan` discovers the current Nx project graph and plans verification without
executing targets. `run` plans the same way, then delegates the selected
targets to the installed Nx CLI, preserving configurations, inferred
executors, command options, environment settings, and prerequisites. The
workspace defaults to the current directory. Both accept:

- `--base <ref>` compares that ref with the working tree.
- `--head <ref>` narrows the comparison to two commits; it requires `--base`,
  and that revision must be the clean checked-out `HEAD`.
- `--all` selects the complete fallback. It cannot be combined with `--base`
  or `--head`.
- `--targets <a,b>` selects exact Nx target names instead of the default
  verification families. Each name must be non-empty.
- `--jobs <n>` sets the worker limit; it must be a positive integer.
- `--json` prints the whole result object. The human two-line summary above is
  not a contract.

Each call rebuilds the declared task inventory, so there is no frozen manifest
to silently omit a newly inferred task.

The default inventory is the exact targets `test`, `typecheck`, `lint`, and
`build`, plus any target starting with `test:`, `typecheck:`, `typecheck-`,
`lint:`, or `lint-`. Continuous targets and targets outside the selection are
reported as excluded. Coverage counts describe this chosen verification scope,
not every runnable operation in the repository; Nx may execute prerequisites
inside a selected target, and Dads counts the selected root invocations.

#### What a registered task's scope is

A plugin-inferred target is scoped, not refused. Each registered task carries a
conservative file scope built from what Nx itself declares:

- the project's own root, and the root of every project it transitively depends
  on;
- the workspace policy files — `nx.json`, `package.json`, the npm, pnpm and
  yarn lockfiles, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.base.json`;
- every file input the target declares, or — when it declares none — the inputs
  of the `targetDefaults` entries keyed by its target name, its executor, or a
  wildcard, with named inputs expanded through the workspace and project
  `namedInputs`;
- the inputs of every configuration, unioned, because a configuration matters
  only when it adds an input the default does not;
- the project root, dependency roots and further prerequisites of every task in
  `dependsOn`. Nx normalizes `^build` into an explicit project list, and those
  projects are frequently outside the declaring project's import graph, so each
  one is followed rather than assumed.

Neither the presence of plugins, nor `targetDefaults`, nor `dependsOn`, nor
configurations is by itself a reason to give up on a scope. External
dependencies are not either: a version change reaches the lockfile and
`package.json`, which are already policy paths.

A task selects on every invocation, with the reason recorded, when an input
cannot be located as a file: a `runtime` or `env` input, an input object that
names neither a fileset nor a JSON file, a named input that does not resolve or
is cyclic, an input path that is absolute or escapes the workspace or covers the
whole workspace, malformed `nx.json`, `namedInputs`, `targetDefaults`, `inputs`,
`configurations` or `dependsOn`, a dependency or prerequisite naming a project
the graph does not carry, and a project rooted at the workspace root, which owns
every path and so cannot be scoped at all.

An unowned changed path reaches the engine's complete fallback. Where the Nx
graph declares a project rooted at `.`, that project owns every otherwise
unowned path and the fallback cannot fire; a root-level file is then in scope
only if Nx's own input model names it. That assumption is written into every
registered task's reason rather than left implied.

This first adapter does not promise symbol-level precision for opaque Nx tasks;
Nx remains authoritative for their execution. Its input model is documented in
the [Nx input reference](https://nx.dev/docs/reference/inputs).

The working tree may be dirty. Discovery and planning reject concurrent changes
to Git-visible source. Temporary manifests and raw graphs are created only in
an already-ignored directory physically inside the workspace, then removed.
The supported scratch locations are `node_modules/.cache/dads-testing`,
`.nx/dads-testing`, and `tmp/dads-testing`; an actionable error is returned if
none is safe. Keep any retained real-repository evidence outside source
control.

### `dad-test-import-nx <workspace> --sha <full-git-sha>`

An optional, one-way migration. It reads a clean, committed Nx workspace whose
`HEAD` matches the SHA you approved, and writes `dads.testing.json` plus
`dads.testing.import-report.json` beside it.

```sh
dad-test-import-nx /path/to/clean/nx-workspace --sha <full-clean-head-sha>
```

It deliberately converts only fully materialized `nx:run-commands` targets into
argv-based recipes. Nx executors, inferred targets, continuous targets, shell
control syntax and escapes, and Vite/Vitest configs that import `nxViteTsPaths`
stay in the report as an explicit adapter or opaque seam. The generated
manifest contains no Nx command, executor, or runtime dependency. On a
workspace whose targets are plugin-inferred, which is the common shape today,
it converts nothing and says so; `dad-test-nx` is the path there.

It supports the frozen `nx graph --file` JSON shape with `graph.nodes` and
`graph.dependencies`; each `{ source, target }` edge becomes a Dads project
fallback dependency from source to target. An unknown graph shape stops the
import and writes an explicit report rather than guessing edge direction.

## Use it

The package also exports three functions, each taking one options object:

- `planNativeNxTesting(options)` and `runNativeNxTesting(options)` back the
  live adapter. Options are the testing operation request minus `manifestPath`
  and `taskIds` — `workspaceRoot`, `base`, `head`, `all`, `jobs`, plus exact
  `targetNames`. An explicit `nativeBinary` is available for local integration
  testing.
- `importNxTestingWorkspace(options)` backs the migration, taking
  `workspaceRoot`, the approved `expectedGitSha`, and an optional `runner`.

This integration package is not a dependency of `@dads-framework/testing`.

## What it refuses to do

- No import of a dirty workspace. Uncommitted or untracked changes, or a
  `HEAD` that does not match the approved SHA, stop the import: an import is
  only reproducible from a commit somebody named.
- No guessed Nx semantics. An unknown graph shape, a self-dependency, a
  malformed target, or a missing edge array is a refusal with a report, not a
  best-effort conversion.
- No shell in a converted recipe. A command with control syntax or escapes
  stays an opaque seam, because a standalone task has no shell to interpret it.
- No Nx runtime in the generated manifest. If the import succeeds, the output
  runs without Nx installed.
- No scratch files outside the workspace, and none that Git can see. Without an
  already-ignored directory inside the workspace, the adapter stops.
- No results from a moving target. If Git-visible source changes during
  discovery, planning, or execution, the run fails rather than reporting
  numbers it can no longer stand behind.
- No claim of coverage it did not measure. Registered and excluded counts
  describe the selected verification scope only.

## Contract

`planNativeNxTesting` and `runNativeNxTesting` resolve to
`{ coverage, plan, run? }`. `coverage` carries `projects`, `targets`,
`registered`, `excluded`, `always`, and a `tasks` list; each entry names its
`project` and `target`, a `classification` of `registered` or `excluded`, a
`reason`, and for a registered target its `taskId` and an `impactMode` of
`changed-files` or `always`. `plan` and `run` are the testing facade's plan and
run results. `dad-test-nx` exits with the run's exit code, or `0` after a plan.

`importNxTestingWorkspace` resolves to `{ manifest, report, manifestPath,
reportPath }`. The manifest is `schemaVersion: 1` with a workspace rooted at
`.`, its full-fallback task ids, the projects and their fallback dependencies,
and tasks of kind `test`, `typecheck`, `lint`, `build`, or `custom`. The report
records the importer and manifest checksum, the source workspace with its
expected and resolved SHA, tool versions and hashed inputs, the Nx projects,
graph, executors and plugins, per-target audits, dropped fields, and failures.

Both files are written to unique temporary siblings first, and no file is put
in place until every one of them has been written, so a write failure replaces
nothing. Two named paths cannot be replaced in a single filesystem step: the
files are then renamed in order, and a rename that fails leaves the outputs
before it replaced and the rest as they were. The report's `manifestChecksum`
is the digest of the manifest bytes, so a pair torn that way does not read as a
matching pair. No temporary file survives either outcome.

Failures are thrown as errors and, at the CLI, written to stderr. Notable ones:

| Message                                                                                       | When                                                   |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `Usage: dad-test-nx plan\|run [workspace] …`                                                  | No operation, or more than two positionals             |
| `Usage: dad-test-import-nx <nx-workspace-root> --sha <full-git-sha>`                          | Wrong argument shape; exits `2`                        |
| `--all cannot be combined with --base or --head.`                                             | Conflicting scope options                              |
| `--head requires --base.`                                                                     | `--head` alone                                         |
| `Nx --head planning requires that revision to be the clean checked-out HEAD. …`               | `--head` names another revision, or the tree is dirty  |
| `--jobs must be a positive integer.`                                                          | A non-positive or non-integer `--jobs`                 |
| `--targets requires non-empty exact target names.`                                            | An empty entry in `--targets`                          |
| `Refusing Nx import: no locally installed Nx package was found under <path>/node_modules/nx.` | No local Nx install                                    |
| `Refusing Nx import: source workspace has uncommitted or untracked changes.`                  | The import workspace is dirty                          |
| `Refusing Nx import: expected Git SHA <a> does not match clean HEAD <b>.`                     | The approved SHA is not what is checked out            |
| `Unsupported Nx graph shape: …`                                                               | The graph is not the supported `nx graph --file` shape |
| `No non-continuous verification targets were registered.`                                     | Nothing in scope could be registered                   |
| `No standalone Nx tasks were convertible; see dads.testing.import-report.json.`               | Nothing converted; the report is still written         |
| `The Nx adapter needs an ignored scratch directory inside the workspace. …`                   | No safe ignored scratch location                       |
| `The workspace changed during Nx discovery, planning, or execution. …`                        | Git-visible source moved mid-run                       |

## Daddy issues this prevents

A migration that guesses is worse than one that stops: it converts what it
understood, drops what it did not, and leaves you believing the suite still
covers you. Everything unconvertible here is written down by name, so the gap
is a list rather than a surprise.
