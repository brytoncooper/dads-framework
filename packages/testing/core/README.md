# Dads Testing

`@dads-framework/testing` decides which of your declared verification tasks a
change actually requires, and runs them.

## What Dad does for you

Dad will not rerun the whole workspace because one file moved, and he will not
skip your test to save four seconds. Every skip he takes, he can prove; when
the proof runs out he widens out loud, with a reason and a line number.

## Try it

Use Node.js 22 or newer and Git. The npm install below is for the public
release and includes the [matching native runtime](#native-packages). For a
source checkout, first run the following from its root, then skip the
`npm install` line in the example.

```sh
npm ci
npm run build
cargo build -p dad-test
export DADS_TEST_NATIVE_BINARY="$PWD/target/debug/dad-test"
export PATH="$PWD/node_modules/.bin:$PATH"
```

Run the example in an empty directory.

```sh
npm init -y
npm install --save-dev @dads-framework/testing
git init -q
printf 'node_modules/\n' > .gitignore
mkdir -p api web

cat > dads.testing.json <<'JSON'
{
  "schemaVersion": 1,
  "workspace": { "root": ".", "fullFallback": { "taskIds": ["api:test", "web:test"] } },
  "projects": [
    { "id": "api", "root": "api", "fallbackDependencies": [] },
    { "id": "web", "root": "web", "fallbackDependencies": [] }
  ],
  "tasks": [
    {
      "id": "api:test",
      "project": "api",
      "kind": "test",
      "execution": { "executable": "node", "args": ["--version"], "cwd": "api" },
      "dependsOn": [],
      "impact": { "mode": "project" }
    },
    {
      "id": "web:test",
      "project": "web",
      "kind": "test",
      "execution": { "executable": "node", "args": ["--version"], "cwd": "web" },
      "dependsOn": [],
      "impact": { "mode": "project" }
    }
  ]
}
JSON

printf 'export const port = 3000;\n' > api/config.js
printf 'export const title = "Home";\n' > web/config.js
git add .
git -c user.name="Dads Example" -c user.email="example@example.invalid" commit -qm baseline

printf 'export const port = 3001;\n' > api/config.js
PATH="$PWD/node_modules/.bin:$PATH"
dad-test explain
result=$(dad-test run --json)
printf '%s\n' "$result" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).result.run.exitCode'
```

The explanation reports `RUN api:test` and `SKIP web:test`. The run executes
the API task's sample command and prints a run exit code of `0`. To generate
a starting manifest from an existing npm, pnpm, or Yarn workspace, start with
`dad-test init` and review `dads.testing.init-report.json`.

In a checked-in workspace, keep `dads.testing.json` at the workspace root.
The repository's [testing manifest fixture](../../../fixtures/testing/dads.testing.json)
does this in `fixtures/testing/` and makes its test task depend on typecheck.

## Commands

`plan`, `run`, and `explain` share the same selection flags: `--manifest`
(path to `dads.testing.json`), `--base` and `--head` (Git refs), `--all`,
and `--task` (repeatable, one task id each). `plan` and `run` additionally
take `--jobs` and `--report` (with an optional path). `--json` works on every
command and is the contract; the human line format is not.

`dad-test plan` selects tasks and reports one decision per task without
executing anything. With `--report [path]` it also writes the analysis report
described under [Contract](#contract).

`dad-test run` selects the same way and then executes the selected tasks as a
dependency-aware DAG, four workers at a time by default; `--jobs` sets a
different positive limit. Independent tasks keep going after another task
fails; dependents of a failed or blocked prerequisite are blocked. By default
every selected task executes fresh. Passing `--cache` opts into content-hashed
passing receipts persisted under Git metadata (invalidated by any source,
policy-file, manifest, command, `execution.env`, runtime fingerprint, or
selected-file change; failing runs never write receipts); `--no-cache` forces
fresh execution. Passing `--remote-cache <url>` (or setting
`DADS_TESTING_REMOTE_CACHE_URL`, with optional
`DADS_TESTING_REMOTE_CACHE_TOKEN`) adds a fail-closed L2 remote receipt store
(`file://`, `http://`, or `https://`) shared across workers.

`dad-test explain` prints the same selection in readable lines, taking
`--manifest`, `--base`, `--head`, `--all`, `--task`, and `--json`:

```
explain: N of M tasks selected, K skipped, W widened detail=engine|derived
scope: <scope facts>
full-fallback: yes|no
  forced-by <issue>
RUN|SKIP <id> project=<p> reason=<code> confidence=<c> widened=yes|no
  because <plain words>
  file <selected test path>
  changed <path>
  export <symbol> <path>
  import <path>:line:col from <path> [symbols]
  prerequisite-of <id>
  direct-task-input <id>
  issue <code> <path:line:col> <message>
  fallback-dependency <project>
info <code> <message>
```

`forced-by` lines appear only when the fallback is full. `detail=engine` means
every cause came from the plan the native engine returned; `detail=derived`
means that engine predates structured causes, so `explain` reconstructs what
each reason code implies from the plan and the manifest instead.

`dad-test init` refuses Nx workspaces and writes an unsuccessful coverage report
instead of treating a few root scripts as the repository's entire task inventory.
Use `dad-test-nx plan` for those repositories. The [Nx adapter and import guide](nx/README.md)
covers both CLIs and the `@dads-framework/testing/nx` API.

`dad-test init` writes `dads.testing.json` at the workspace root, taking
`--manifest`, `--force`, and `--json`. It detects the package manager — npm,
yarn, or pnpm — from the lockfile. Workspace patterns come from
`pnpm-workspace.yaml`'s `packages` list of strings; other top-level keys in
that file are ignored and reported, and anything else refuses with a
`file:line` pointing at the problem. Absent that file, patterns come from
`package.json`'s `workspaces` field; absent that, a single-package Dads
application with `dads.project.json` and Vitest gets per-domain projects plus
file-level Vitest narrowing, and any other single-package repository is treated
as one project. Recognized `test` scripts become `reachability` tasks; `typecheck`,
`lint`, and `build` scripts become `project` tasks; `test` depends on
`typecheck`; and `fallbackDependencies` come from workspace dependencies and
`tsconfig` references. `init` refuses to overwrite an existing manifest
without `--force`, and a workspace with zero recognized scripts still gets a
report before `init` refuses.

Toolbox's `dad test plan|run|explain|init` is a passthrough to the commands
above. Toolbox's own `dad init` (scaffolds an application) and `dad explain
<path>` (names which package owns a path) are unrelated commands.

## The manifest

```json
{
  "schemaVersion": 1,
  "workspace": { "root": ".", "fullFallback": { "taskIds": ["api:test"] } },
  "projects": [{ "id": "api", "root": "apps/api", "fallbackDependencies": [] }],
  "tasks": [
    {
      "id": "api:test",
      "project": "api",
      "kind": "test",
      "execution": { "executable": "npm", "args": ["test"], "cwd": "apps/api" },
      "dependsOn": [],
      "impact": { "mode": "reachability" }
    }
  ]
}
```

All fields are strict. Paths must stay within the workspace. Project and task
ids are unique, all references must resolve, task cycles are rejected, and
`workspace.fullFallback.taskIds` must list every task exactly once. Ordinary tasks are an executable plus arguments (with optional `env` key-value
pairs passed to the process and hashed into receipts); an explicit `shell: true`
runs `executable` and `args` through the platform shell for shell recipes. A `reachability` test task may also declare `execution.fileNarrowing`
(`suffixes`, optional `excludeSuffixes`, and optional `setupFiles`) so that an
un-widened run appends only the reached test files to `execution.args` and
skips the task when zero matching test files are reached. Workspaces with SQL
migrations may declare `workspace.sql` (`migrationRoots`, `objects`, `edges`,
and optional `snapshotPatterns`) alongside per-task `sqlImpact`
(`isMigrationRunner`, `tables`, or `hasUnmappedSql`) so table-scoped DDL runs
migration runners plus only affected database domains via bidirectional FK
closure while global/unrecognized DDL widens safely to all database tasks.
Workspaces may also declare `workspace.nonCodeSuffixes` (for example `[".md"]`)
so documentation-only edits do not widen JavaScript/TypeScript reachability.

## How selection works

- Without refs, scope is `HEAD` plus staged, unstaged, deleted, renamed, and
  untracked working-tree paths.
- `--base` compares that base with the working tree; `--base --head` compares
  two commits; `--all` selects the complete fallback with no Git comparison.
- An unknown changed path selects the complete fallback.
- A direct task input selects that task's prerequisite closure.
- A task with `impact.mode` `always` runs in every plan.
- Otherwise selection is reachability from persisted graph-analysis state
  built from the Oxc symbol graph. Oxc sits behind a language-neutral frontend
  boundary, so other language frontends can contribute the same facts without
  changing the planner. This state is analysis state, never a result cache.
- That state is keyed to the current head and the resolved comparison base,
  because it carries the changed-export evidence that base implies; alternating
  between two bases re-analyzes rather than reusing.
- That graph is analyzed only when the manifest declares at least one
  `reachability` task; a manifest whose tasks are all `always`, `changed-files`,
  or `project` reaches the same plan without it, so the workspace is not parsed,
  the persisted state is not read or rewritten, and the plan says so with a
  `graph-analysis-unneeded` issue.
- If a graph fact is unavailable or untrusted for an owned path, Dads widens
  from that project through its declared `fallbackDependencies`. Unowned paths
  and unowned graph uncertainty select the complete workspace fallback.
- The only skip decision is `skip-proven-unaffected`.
- A project rooted at `.` owns every path in the workspace.

## What it refuses to do

- The core API and `dad-test` run without Nx. The Nx adapter uses the target
  workspace’s local Nx installation.
- No implicit test-result cache: every `run` executes its selected tasks fresh
  unless the caller explicitly passes `--cache` (which only reuses a verified
  passing receipt when the entire content-hashed input closure matches, and
  `--no-cache` always overrides it).
- No daemon, no network service, no telemetry.
- No skip it cannot prove.
- `DADS_TEST_NATIVE_BINARY` is for local development only. When it is set it
  replaces the platform package: it is read before any package lookup, it must
  point at an existing executable, and the resolution records
  `DADS_TEST_NATIVE_BINARY` as the source of that path. An explicit
  `nativeBinary` option is read before the variable.

## Contract

The plan JSON carries `scope`, `tasks`, and `issues`. A task has `id`,
`decision`, `reason`, `confidence`, and `widened`, plus an optional `project`
that owns it, optional `reachedFiles` and `selectedFiles` lists for narrowed
test selection, and an optional `causes` list naming every reason it was
selected: a direct task input, a prerequisite of another selected task, a
changed path, a changed export, a reached import (with its location, the
module it was imported from, and the symbols), a plan issue, or a fallback
dependency. An issue has `code` and `message`, and may carry `severity`,
`scope`, `path`, `line`, `column`, and `project`. A cause of kind `issue`
holds an `index` into `issues` as emitted, so a reader that reorders or
filters issues must resolve that reference against the original order. Every
one of these fields is optional for one reason: a missing field means the
engine that produced the plan is older than this facade, not that the fact
does not hold.

A run reports each selected task as `executed`, `failed`, `blocked`, or
`not-applicable`. Executed tasks may include `durationMs`, captured `stdout`
and `stderr` (each with `text` and `truncated`), and an `error` explanation.

`--report [path]` writes the report; `--json` embeds the same object under
`result.report`. It carries totals by reason and confidence; the fallback's
full/`forced-by` state, issue counts by code and severity, and the widening
issues with their locations; a `projectClosure` comparing the manifest's
transitive `fallbackDependencies` closure of changed projects against what was
actually selected, including a `reductionRatio` expressing the Dads selection
as a fraction of what an Nx-style project closure would have run; the
`execution` results; and `receipts`. These numbers are descriptive: they say
how much narrower the selection was and why it widened, not whether it was
correct. Judging correctness needs an oracle — a known-required task set —
and that comparison is out of scope for the report.

`init` writes `dads.testing.init-report.json` beside the manifest, recording
workspace facts, each package's tasks and skips, inferences, unsupported
constructs, the manifest's checksum, and the validation method: `native` when
a binary was available, otherwise `structural`, or `none`.

The package also exposes `planTesting(request)` and `runTesting(request)`.
Each operation makes one JSON request to the native `dad-test` process. For
deterministic simulation testing (seeded PRNG, simulated `Clock`, UUIDv7,
shrinking invariant runner, and fault-injecting adapters), see the
[DST guide](dst/README.md) (`@dads-framework/testing/dst`).

## Native packages

The public npm release will ship platform executables as separate optional
packages for macOS arm64/x64, Linux glibc arm64/x64, and Windows x64. npm selects
the dependency matching the host platform and architecture, and the facade
uses its executable.

Inside this repository those packages are deliberately not npm workspaces:
each declares `os` and `cpu`, and npm refuses to install a workspace whose
platform does not match the host. As plain optional dependencies, `npm ci`
links the package for the current platform and skips the rest. For local
development, build the native CLI with `cargo build -p dad-test` from
the repository root and set `DADS_TEST_NATIVE_BINARY` to the resulting
`target/debug/dad-test` executable (`dad-test.exe` on Windows).

## Daddy issues this prevents

Two failures wear the same face: the suite that reruns everything because
nobody could say what changed, and the suite that skips your test because
somebody once said "that's unrelated" and never wrote down why. Here
uncertainty always widens, and it always leaves a note.
