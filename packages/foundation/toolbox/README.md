# `@dads-framework/toolbox`

The optional `dad` command line. It initializes and adopts Dads projects,
explains which package owns a path, plans and runs the verification a change
earns, and inspects HTTP and code-health rules. Application runtime packages can
operate without it.

## What Dad does for you

Dad answers the two questions nobody writes down: who owns this file, and what
has to pass before it ships. He answers them from the project's own
declarations, so the answer does not change with who is asking.

## Try it

From a Dads application such as the generated starter, install the Toolbox
and ask which package owns the notes route.

```sh
npm install --save-dev @dads-framework/toolbox
npx dad orient domains/notes/server/routes.ts --json
```

The result contains `ok: true` and identifies the owner, its verification
commands, and the path to its README. Run `npx dad doctor explain enmeshment`
to see the explanation for that diagnostic.

To create a project that already includes the Toolbox, run
`npm create dads@0.3.0 my-app` with Node 24 and Docker Compose running.

Dads is the framework; its packages live under `@dads-framework/*`, and `dad`
is the executable this package exposes. `dad --help` (or `dad help`) prints the
command index. Run `dad add --help` for the generator index.

Run the command from the generated app root. The starter’s
[`dads.project.json`](../../../apps/kit-workbench/dads.project.json) declares ownership and verification, and
[`domains/notes/server/routes.ts`](../../../apps/kit-workbench/domains/notes/server/routes.ts) is the file passed to `orient`.

## Commands

Add `--json` to the documented command to emit machine-readable output. Without it, most commands print the same object
pretty-printed; `orient`, `explain`, `skills:sync`, and `verify` have their own
plain-text form, and only the JSON form is a contract.

### Projects

`dad init <path> [--existing] [--name <name>] [--dry-run] [--skip-install] [--json]`

Applies the same idempotent recipes as `create-dads`. `--existing` writes an
isolated project under `<path>/dads` beside an existing application,
`--dry-run` previews the owned files, and `--skip-install` leaves dependency
installation to another tool. Use `npm start` in the generated app to start
Docker, or use `npm create dads@0.3.0` to install and start a new app in
one step.

Generated projects include Git hooks, a shared CI shell job, and optional GitHub
Actions and GitLab CI adapters. Run `npm run hooks:install` at the Git
repository root to activate staged checks and exact-tree push verification.
[CI setup](../../../ci/README.md)

`dad skills:sync [--json]`

Links `.cursor/skills`, `.claude/skills`, and `.codex/skills` at
`../.agents/skills` so every harness reads one skill library. Each harness is
reported as `created` or `correct`.

`dad migrate 0.3 [path] [--dry-run] [--json]`

Rewrites a `0.1.x` or `0.2.x` workspace to the consolidated `0.3.0` package
surface: updates every `package.json` (deduplicating merged packages and adding
any newly-optional peer providers the project already used), rewrites TypeScript,
JavaScript, CSS, and `tsconfig*.json` specifiers to their new subpaths, and
updates `dads.project.json` boundaries. Idempotent and safe to preview with
`--dry-run`.

### Orientation

The `documentation` field in JSON points to the owning README or project
guide. `dad doctor explain` includes the relevant diagnostic guide. When the
project has no local guide, the command links this package README.

`dad orient <path> [--json]` — and `dad explain <path>`, the same command under
the name an agent tends to reach for — names the package that owns a path, its
responsibility, its skills, and its verification commands. A path no declared
package owns is an error, not an empty answer.

`dad inspect http-operation "GET /products/:id" --json` reads matching route
declarations in the project's TypeScript sources. The report includes the
source location, method, path, schemas, and whether the route declares access.

### Diagnosis

`dad doctor [path] [--profile standard|strict] [--issue <id>]* [--json] [--today YYYY-MM-DD]`

Reports a repository against the seventeen failure modes
[`DAD.md`](../../../DAD.md) names and
[`docs/daddy-issues.md`](../../../docs/daddy-issues.md) defines. The path
defaults to the working directory. `--issue` may be repeated and narrows the
report to the issues it names; the ids are the companion's heading anchors,
`daddy-issues` through `dad-has-issues-too`.

It reads the hand-written files (tracked files
when the path is a git repository, otherwise a walk that skips `node_modules`,
build output, and dot-directories, and in both cases skipping `*.generated.ts`),
the package declarations in `dads.project.json` or, failing that, every
workspace `package.json`, and the output of the commands a signal declares it
must run. The local hook runtime signal also reads the ignored
`.dads/hook-timings.jsonl` when the checkout has collected samples. It never reads the clock: a date arrives through `--today` or the
signals that need one report that they were not measured.

Each issue prints one line per signal — the id, the number, the threshold, the
profile the threshold came from, and the state — followed by the sentence from
`DAD.md` the rule answers with. A signal is `over` when a key is above its
ceiling, `ok` when none is, `report` when this profile gives it no threshold,
and `not measured` when its input was absent or unreadable. A signal that ran
and found nothing says `0 seen`; only a signal that could not run says it was
not measured. Nothing is ever at `warn`.

The issue's verdict is one of three:

- `present`: a signal with a threshold in this profile is over it.
- `partial`: no threshold was crossed, and a signal this profile only reports
  but the strict profile judges saw something. A signal no profile judges is
  information, not evidence, and moves no verdict.
- `absent`: everything else, including an issue no signal reads yet, which the
  report says in place of its signal lines.

A floor moves no verdict. Its judge is the recorded baseline the gate below
reads; in the report it prints its number and says `report`.

`--profile` picks the posture. `standard` is the default; `strict` may only
tighten a threshold, never loosen one, and a line whose threshold the strict
profile supplied says `strict` beside it.

The report exits `0`. Pass `--online` to enable network checks.
Unknown options are rejected.

`dad doctor [path] --gate|--update|--seed|--report|--file <path>|--base <ref>
[--today YYYY-MM-DD] [--reason <text>] [--key <key>] [--json]`

The gate is the same measurement, judged against a recorded baseline instead of
described. It reads and writes `.agents/source-budgets.json`: a ceiling is a
number that may not grow, a floor is a number that may not shrink, and an entry
in the baseline is an exception that may only ever move toward the threshold.
Every flag below implies the gate, so `--gate` is written only when no other
mode is. The gate exits `1` on any violation.

`--gate` judges every signal the active profile gives a number to, and every
floor, which is judged against the number it was recorded at. A signal this
profile only reports is not gated, because there is nothing to judge it
against. A signal that cannot answer — no history to read, no `--today` for a
signal that counts days — says so as a warning, fails nothing, and leaves its
recorded entries alone.

`--update` applies every downward move and writes the baseline: it lowers a mark
to the number measured, deletes an entry whose key came back under the
threshold, and raises a floor. It never adds a ceiling entry and never raises a
mark, because a new offender is a split rather than a recording.

`--seed --today YYYY-MM-DD [--reason <text>] [--key <key>]` records an exception
for a key that is over its ceiling and not yet listed, with the reason it was
given and the date it was given. It only ever adds: an entry the baseline
already holds is left exactly as it is, so seeding twice cannot loosen anything.
`--key` narrows it to one key, which is how an exception gets a reason of its
own rather than one shared with every other key seeded that day.

`--report` lists every key that is listed or over its threshold, largest first,
with its mark; `--json` adds the same rows as an `inventory` array.

`--file <path>` judges a repository-relative path, including newly created
files. Repeat the option to check several paths in one run. File checks leave
repository-wide floors, Git history, and network checks to the full gate.

`--base <ref>` compares this baseline against the one at a ref and fails on
every direction of loosening — a mark that rose, a floor that fell or was
removed, an entry that lost its reason, an ESLint suppressions file that grew.
An entry the ref does not carry is a new exception: it is listed and it does not
fail, because a reviewer is the right gate for a new exception.

A floor may fall in one case. Where the entry carries `movedTo`, naming another
key in the same section, and that key rose in the same comparison by at least
the fall, the fall is a count that moved — a package split — and it is listed as
a move rather than failed on. The entry still needs its reason, a `movedTo` that
names its own key or a key the section does not record is an error in every
mode, and no mode writes the field: only whoever made the split can say where
the count went.

`--seed` and `--update` are exclusive; `--base` only reads, so it combines with
neither; `--file` combines with neither `--base` nor `--seed`;
`--reason` and `--key` are refused without `--seed`; `--seed` is refused without
`--today`.

`dad baseline init [path] --reason <text> [--today YYYY-MM-DD] [--json]`

Adopt the code-health ratchet in a standalone TypeScript repository. The command
records existing findings with a reason in `.agents/source-budgets.json` and
sets up the strict threshold profile in `.agents/source-ratchet.json`. The CI
gate measures the proposed source and checks the adopted policy and baseline
against a trusted ref. See the [standalone ratchet CI recipe](../../../ci/source-ratchet.md).

`dad doctor explain <issue-id> [--json]`

Prints one issue: the sentence from the essay, the links to both documents, the
companion's numbered test with the signal that answers each question, the
signals Dad measures today with their thresholds, and the cure. It is a
subcommand of `doctor` because `dad explain <path>` is already the orientation
alias above.

### Changed verification

`dad test:recommend --changed [--base <ref>] [--json]`

A read-only candidate plan. It reads the declared task graph, finds changed
owners and their dependent verification, and reports why each task is `run`,
`pending-provider`, `reuse-candidate`, or `unknown-scope`. It never claims a
check ran, and it exits `1` when the plan is incomplete.

Changed scope is the comparison base — `HEAD`, or an explicit `--base <ref>` —
plus staged, unstaged, untracked, renamed, and deleted paths. An invalid
explicit base is an error. A default clean scope has no trusted baseline and
therefore selects the configured conservative full fallback. Unknown executable
scope does the same, instead of returning an empty success.

`dad verify --changed [--base <ref>] [--full] [--no-cache] [--json]`

Executes the same selection in dependency order and reports every selected task
as:

- `executed`: the task ran against its captured inputs.
- `reused`: a supported controlled task has an exact matching successful local
  receipt for the current consumed inputs and provider artifact.
- `failed`: the selected task ran and failed.
- `blocked`: a prerequisite failed, so the task was not credited.
- `not-applicable`: no work was required for that task.

`--full` disables Dad result reuse for the selected graph. So does the cache
being off: with `CI` set, or with `--no-cache`, no receipt is even looked up,
so a CI run never credits evidence left by an earlier run. Repository-wide
delivery verification remains a separate project command.

#### What Dad may reuse

Reuse is deliberately limited to Dad's mechanically validated
artifact-consumer adapter. The graph runs from one isolated checkout and
manifest snapshot. It captures an immutable copy of declared source, tests,
fixtures, configuration, resolved dependencies, lockfile, generated artifacts,
command, toolchain, platform, and non-secret environment inputs. A task
receives credit only after successful execution and required outputs. The
receipt identifies the exact snapshot it proves, including the hash derived
from the executing Dad toolbox. Consumed artifact bytes must equal the current
provider output fingerprint.

Workspace snapshots preserve plain directories as directories. For a Git
workspace, Dad captures the working-source inventory and real `HEAD` in
independent metadata so root Git checks can discover the snapshot and run
against its copied files. Dad records available local main-branch references
and a checkout-relative hook path for the history and hook checks. Those facts
enter receipt identity. The snapshot has no configured remote, and its index
represents the captured source available to verification.

Shell commands, live services, mutable integrations, secret-dependent tasks,
and unknown inputs always execute. Provider failure blocks its consumers even
when an old output exists. Missing, corrupt, foreign, interrupted, or stale
receipts cause execution; they never fabricate success.

Receipts live under the ignored `.dads/verification/` directory. They are local
evidence, not source files or shared authority. Do not edit, commit, or copy
them between projects. Deleting them is safe and simply forces the relevant
work to run again.

The first concrete proof lives in `fixtures/boundary-verification`. It executes
the real compiled artifact consumer, demonstrates a source-only provider change
that preserves exact artifact bytes, and independently proves that changes to
policy output, consumer code, tests, configuration, engine, binding, lockfile,
toolchain, or declared environment execute again. Full and optimized
verification both catch an injected consumer failure; the optimization changes
work performed, not the expected answer.

### Test selection passthrough

`dad test plan|run|explain|init [--manifest <path>] [--base <ref>] [--head <ref>] [--all] [--task <id>]* [--jobs <n>] [--report [path]] [--force] --json`

A passthrough to `@dads-framework/testing`'s `dad-test` command line, which
owns those four subcommands and their options; the exit code is the one that
command returns. Note that `dad init` and `dad explain <path>` above are
unrelated commands with the same names.

### Domain boundaries

`dad check boundaries [--json]` resolves project imports and checks domain,
neutral library, workflow, integration, and composition ownership, plus
intra-domain layering (`pure/`, `contract/`, `access/`) and mixed server/client
root barrels. The checker exits unsuccessfully on violations and identifies the
source, target, and fix. Starters include it in local and CI verification. See
the [domain boundaries guide](../../../docs/domain-boundaries.md) for default
paths, custom roots, and a two-API example.

### Generators

`dad add --help` lists the eleven commands for domains, endpoints, tables,
access, flags, email, pages, resources, workflows, integrations, and dependency
libraries. In the starter, preview a domain on the staff API with
`npx dad add domain inventory --api staff --dry-run --json`. The preview
lists the planned files and registration without editing the project.
[Generator guide](../../../docs/generators.md)

### Dependency libraries

`dad add library <name> [--dry-run] [--json]` creates an application-owned
TypeScript package in `libraries/<name>` with a public export, declarations,
a smoke test, and workspace and ownership entries. Run `npm install` to
update workspace links and the lockfile. See the
[dependency library guide](../../../docs/dependency-libraries.md) for the
workflow from an owning repository to a consuming repository.

### Access schemas

`dad access import <schema.zed> [--out <path>] [--dry-run] [--json]`

Reads a SpiceDB `.zed` schema file, parses it with `@dads-framework/access`,
and emits strict Dads TypeScript (`actor`, `resource`, `compileAccess`).
Without `--out` or `--json`, the generated TypeScript prints directly to stdout
so `npx dad access import schema.zed > access.ts` works out of the box. With
`--out <path>`, Dad creates parent directories and writes the file unless
`--dry-run` is set. Unsupported SpiceDB constructs such as `caveat` fail with a
line-numbered error and exit `1`.

`dad access tree <schema.ts|schema.zed> [--json]`

Loads a TypeScript/JavaScript access module (`.ts`, `.mts`, `.js`, `.mjs`)
exporting an `AccessModel` or `actor`/`resource` definitions, or a SpiceDB
`.zed` schema file, and renders the deterministic ASCII hierarchy tree showing
actors, resources, roles, permissions, and inherited children.

`dad access diff <before> <after> [--json]`

Loads both access sources (`.ts`, `.mts`, `.js`, `.mjs`, or `.zed`, including
mixing `.ts` and `.zed`) and compares resources, roles, subject types,
expiration flags, and computed permissions. Every change is classified as either
`safe` or `breaking` (`removed-resource`, `removed-role`, `narrowed-role`,
`removed-expiration`), with `requiresMigration` indicating whether stored
relationships must be migrated before writing the new schema.

`dad access migrate <slug> --from <before> --to <after> [--out <dir>] [--dry-run] [--json]`

Computes the schema diff between `<before>` and `<after>` (`.ts`, `.mts`,
`.js`, `.mjs`, or `.zed`), assigns the next sequential `NNNN_<slug>` identifier
in `--out` (defaulting to `./access/migrations`), and scaffolds a connected
`(from, to)` migration file using `defineAccessMigration` pre-populated with
typed `copyRole` / `dropRole` stubs and snapshot metadata. Pass `--dry-run` to
preview without writing. Run `dad access --help` for subcommand usage.

## Use it

The package also exports the surface the CLI is built from, which is how
`create-dads` reuses the same recipes:

- Projects: `initializeDadsProject`, `deriveDadsProjectName`,
  `parseDadsInitializationArguments`, `dependenciesAreInstalled`,
  `recordDadsDependencyInstallation`.
- Orientation: `loadDadsProject`, `findDadsProjectRoot`, `parseDadsProject`,
  `orientProjectPath`, `recommendChangedVerification`,
  `synchronizeAgentSkills`.
- Access: `loadAccessSource`, `importZedSchema`, `renderAccessTree`,
  `renderZedAccessTree`, `diffAccessSources`, `diffZedSchemas`,
  `diffAccessIrDefinitions`, `scaffoldAccessMigrationFromSources`,
  `scaffoldAccessMigration`, `DEFAULT_ACCESS_MIGRATIONS_DIR`.

## What it refuses to do

- No runtime dependency in the other direction. Framework packages never
  import this one, so a project can drop the CLI and keep the framework.
- No ownership it was not told about. `orient` and the changed
  plan read `dads.project.json`; a path no declared package owns is an error
  rather than a default.
- No overwriting. Initialization and library creation preserve existing files.
- No skip it cannot prove. Reuse requires an exact receipt for the current
  inputs; anything missing, stale, foreign, or corrupt executes again.
- No treating an empty scope as a clean bill of health. Without a trusted
  baseline, selection widens to the configured full fallback.
- No verdict without a number. `doctor` prints the reading, the threshold, and
  where the threshold came from on every line. See the
  [Doctor command reference](../../../docs/doctor.md) for gate and report modes.
- No clock. `doctor` takes a date only from `--today`, so two runs over one
  tree print the same bytes.

## Contract

Commands take arguments as shown above. Every value option may appear once and
requires a value; `dad init` additionally rejects a repeated flag and a second
positional argument.

A successful `--json` run prints one line beginning `{"ok":true,…}`. `init`
reports `initialization` and `installed`. `add library` reports `result`.
`access import` reports `inputPath`, `outPath`, `definitionCount`,
`definitions`, `dryRun`, `written`, and `code`.
`access tree` reports `inputPath`, `definitionCount`, `definitions`, and
`tree`.
`access diff` reports `beforePath`, `afterPath`, `safe`, `breaking`,
`permissionChanges`, `requiresMigration`, and `summary`.
`access migrate` reports `id`, `slug`, `fromPath`, `toPath`, `outDir`,
`filePath`, `dryRun`, `written`, `requiresMigration`, `diff`, and `code`.
`test:recommend` prints `changedScope`, `recommendation`, and `notApplicable`;
`verify` prints those plus `report`. A failure prints
`{"ok":false,"error":"<message>"}` on stderr and exits `1`; without `--json`
the same message is written as `Dad: <message>`.

`changedScope` is `{ comparisonBase, paths, workspaceIdentity }`. A
recommendation carries `packages`, `tasks`, `unownedPaths`, `unknownPaths`,
`usedFullFallback`, `complete`, and `issues`; each task has `taskId`,
`packageName`, `command`, `state`, `reason`, and `dependsOn`. A verification
report carries `ok`, `full`, `results`, `counts` by status, and `issues`; each
result has `taskId`, `command`, `status`, `reason`, `snapshotId`, `receiptId`,
and `outputs`. Without `--json`, `verify` prints one padded line per task
followed by
`executed=<n> reused=<n> failed=<n> blocked=<n> not-applicable=<n>`.

Errors, and when each happens:

| Message                                                                        | When                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `Could not find dads.project.json from <path>.`                                | No Dads project above the working directory             |
| `orient requires a project-relative path.`                                     | `orient` or `explain` with no path                      |
| `No declared package owns <path>.`                                             | `orient`, `explain`, on an unowned path                 |
| `inspect requires http-operation "<METHOD /path>".`                            | A malformed `inspect` invocation                        |
| `--profile must be standard or strict.`                                        | `doctor` with any other profile                         |
| `No daddy issue is named <id>.`                                                | `doctor --issue` or `doctor explain` with an unknown id |
| `--today must be a date written YYYY-MM-DD.`                                   | `doctor --today` with anything else                     |
| `doctor takes at most one path.` / `doctor explain requires an issue id.`      | A malformed `doctor` invocation                         |
| `No literal HTTP operation named <name> was found.`                            | `inspect` matched nothing                               |
| `Refusing to initialize non-empty directory <path>. …`                         | `init` target holds files and no `dads.project.json`    |
| `Refusing to overwrite conflicting file <path>.`                               | An owned file exists with different content             |
| `Unknown option <option>.` / `Option <option> was provided more than once.`    | A bad `init` argument list                              |
| `<option> requires a value.` / `<option> may only be provided once.`           | A value option given wrongly                            |
| `Invalid verification base <ref>.`                                             | `--base` names no commit                                |
| `Unable to read the changed git scope[: <detail>]`                             | Git could not report the changed paths                  |
| `Refusing to replace existing package script <name>. …`                        | A recipe script name is already taken                   |
| `access import requires a path to a .zed schema file.`                         | `access import` with no schema path                     |
| `access tree requires a path to a .ts or .zed access file.`                    | `access tree` with no schema path                       |
| `access diff requires <before> and <after> schema file paths (.ts or .zed).`   | `access diff` with fewer than two schema paths          |
| `access migrate requires a migration slug.`                                    | `access migrate` with no slug                           |
| `access migrate requires --from <before>.` / `--to <after>.`                   | `access migrate` missing `--from` or `--to`             |
| `Zed schema file not found: <path>.` / `Access schema file not found: <path>.` | `access` command with a missing schema file             |
| `npm install failed[: <detail>]`                                               | Dependency installation failed                          |

The package requires Node.js 22 or newer.

## Daddy issues this prevents

"Which tests do I need to run for this?" has two bad answers: all of them,
every time, because nobody could say; and none of them, because somebody once
decided it was unrelated and wrote nothing down. Here the plan is read from the
project's own declarations, and every skip is backed by a receipt that names
what it proved.

## Generate application code

Use `dad add domain|endpoint|table|access|flag|email|page|resource|workflow|integration`
in a kit starter. Choose an API explicitly when exposing a domain. The generator
reference lists output files, dependencies, and dry-run behavior. See
[Generate application code](../../../docs/generators.md).
