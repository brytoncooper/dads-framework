# Daddy issues: definitions and tests

This is the reference-register companion to [`DAD.md`](../DAD.md). The essay
names the failure modes; this page defines them, and every issue there links
here. Each entry gives a definition, a test written as questions, the cure, and
what holds the rule in this repository today. A question answered "yes" means
the issue is present. The questions are the specification of `dad doctor`: each
parenthetical names the signal that answers it.

## Contents

1. [Daddy issues](#daddy-issues)
2. [Anxious attachment](#anxious-attachment)
3. [Avoidant attachment](#avoidant-attachment)
4. [Disorganized attachment](#disorganized-attachment)
5. [Enmeshment](#enmeshment)
6. [You are looking for a father figure](#you-are-looking-for-a-father-figure)
7. [You repeat the cycle](#you-repeat-the-cycle)
8. [You let the babysitter raise them](#you-let-the-babysitter-raise-them)
9. [People-pleasing](#people-pleasing)
10. [You stay with people who cannot meet you](#you-stay-with-people-who-cannot-meet-you)
11. [Commitment issues](#commitment-issues)
12. [Gaslighting](#gaslighting)
13. [The silent treatment](#the-silent-treatment)
14. [Failure to launch](#failure-to-launch)
15. [“It’s not you. It’s my boundaries.”](#its-not-you-its-my-boundaries)
16. [The paper wall](#the-paper-wall)
17. [Dad has issues too](#dad-has-issues-too)

## Daddy issues

**Definition.** The escape hatches: one author revokes a guarantee of the type
system in line, and nothing records it. This entry owns the hatch in
hand-written source; a hatch written down, dated, and required to shrink
belongs to [the silent treatment](#the-silent-treatment).

**Test.**

1. Does any hand-written file annotate a value `any`, or write `as any`?
   (`explicit-any`: any occurrence outside generated files is a yes.)
2. Does any hand-written file use `as` other than `as const`, or a postfix `!`?
   (`type-assertions`, `non-null-assertions`: any hit is a yes.)
3. Is there a `@ts-ignore` or `@ts-nocheck`, or a `@ts-expect-error` outside a
   `type-tests/` directory? (`ts-suppressions`: any occurrence is a yes.)
4. Does any TypeScript file carry an `eslint-disable` comment?
   (`eslint-disables`: any occurrence is a yes.)

**Cure.** Each hatch is a lint error rather than a preference, and the count of
each is a ratchet ceiling locked at zero.

**Held in this repository by.** ESLint `no-explicit-any`,
`no-non-null-assertion`, `consistent-type-assertions` (`assertionStyle:
"never"`), `no-unsafe-type-assertion`, `ban-ts-comment`; `dad doctor --gate`
holding the `eslint-disables` and `ts-suppressions` ceilings at zero.

Essay: [DAD.md](../DAD.md#daddy-issues)

## Anxious attachment

**Definition.** A package merges with what it depends on rather than being
depended on alone: a vendor module, a vendor type, or a copy of another
package's type crosses into a package whose declaration does not admit it, or
one helper is redefined file by file. This entry owns crossings that happened;
the absence of a mechanism that could stop one belongs to
[“It’s not you. It’s my boundaries.”](#its-not-you-its-my-boundaries), and a
module built to stop one and failing belongs to
[the paper wall](#the-paper-wall).

**Test.**

1. Does any workspace dependency edge violate the kind matrix?
   (`kind-inversions`: list every package's `kind` and its edges; any edge the
   matrix forbids is a yes.)
2. Is a vendor module imported outside the integration package declaring it?
   (`vendor-outside-adapter`: any outside importer is a yes.)
3. Does an emitted `.d.ts` name a type from outside its package and its allowed
   dependencies? (`vendor-types-in-surface`: any foreign name is a yes.)
4. Is the same exported type name declared in more than one package with a
   similar shape? (`copied-types`: matching field sets is a yes.)
5. Is the same function name defined in more than one production file of one
   package? (`duplicated-helpers` skips `*.migration.ts` files, whose entry
   points repeat by design.)

**Cure.** Every package declares its kind and allowed dependencies in one place,
and a program compares imports, manifest, and emitted surface against it.

**Held in this repository by.** `check-dependency-boundaries.mjs` against
[`dads.project.json`](../dads.project.json), gates `imports`,
`declared-dependencies`, `public-surface`; `dad doctor --gate` holding the
`kind-inversions`, `duplicated-helpers`, `vendor-outside-adapter`,
`vendor-types-in-surface`, and `copied-types` ceilings.

Essay: [DAD.md](../DAD.md#anxious-attachment)

## Avoidant attachment

**Definition.** A package hands a consumer nothing to program against: no input
or output schema, no access declaration, no envelope, no README in the shared
template, no recorded invariants. The failure is the absence of a contract, not
a wrong one. A contract that exists but was never published as the package's
own belongs to [failure to launch](#failure-to-launch).

**Test.**

1. Does any route blueprint lack an input or an output schema?
   (`routes-without-schema`: a route missing either is a yes.)
2. Does any route blueprint carry no access declaration?
   (`routes-without-access`, cross-listed as `latchkey-routes` under
   [you repeat the cycle](#you-repeat-the-cycle).)
3. Does any handler return a raw array or object rather than the envelope?
   (`responses-outside-envelope`: any such return is a yes.)
4. Does any package lack a README, or carry one outside the template?
   (`readme-missing`, `readme-nonconformant`: absence from the conformance list
   is a yes.)
5. Does any non-artifact package lack an `INVARIANTS.md`?
   (`invariants-missing`: any such package is a yes.)

**Cure.** A route without a schema and an access declaration does not register,
and README and invariants coverage is a floor that may rise and never fall.

**Held in this repository by.** `check-docs.mjs` against
[`docs/readme-conformance.json`](./readme-conformance.json); the
`dad doctor --gate` holding the `docs-conformance-packages` and
`invariants-files` floors, the latter keyed per package, and the
`readme-missing` ceiling. HTTP route cards declare schemas, access, and response contracts; the gate's `routes-without-schema`,
`routes-without-access`, and `responses-outside-envelope` ceilings read this
repository's own blueprints and are at zero.

Essay: [DAD.md](../DAD.md#avoidant-attachment)

## Disorganized attachment

**Definition.** Two rules operate inside one package and which applies is
decided per file: a parsed schema in one module and a hand-written type in
another for one wire shape, a validated boundary read here and a trusted one
there. The inconsistency is the failure, because no reader can predict which
guarantee holds without opening the file.

**Test.**

1. Does any file declare an `interface` where the house rule is `type`?
   (`interface-type-mix`: any `interface` declaration is a yes.)
2. Is the result of a boundary read — `JSON.parse`, `process.env`, a file read,
   a request body — used without passing through a parser in the same function?
   (`unparsed-boundary-reads`; heuristic. Proxy: the result reaches a typed
   position with no parse call between them.)
3. Do two schemas describe one wire shape? (`duplicate-wire-schemas`;
   heuristic. Proxy: two declarations with identical field-name sets.)
4. Does any test file use `as`?
   (`assertions-in-tests`: any occurrence is a yes.)
5. Does a `jsonb` column carry no `.$type<T>()`, or one whose type is not a
   named, imported or declared type? (`jsonb-without-schema`: any such column
   is a yes.)
6. Is a migration added past the base stamped older than its journal's newest
   on the base, or does one state prerequisites the runner cannot satisfy?
   (`migrations-out-of-order`: such a stamp, a `dependsOn` that is not an
   exported literal list, a missing prerequisite, or a cycle is a yes. The base
   is `origin/main`, else `main`; with neither, each migration is read against
   what its directory held when it was added, and the report says so.)

**Cure.** One representation per wire shape, every boundary read parsed at the
read, and the assertion rules applied in test and type-test scopes too.

**Held in this repository by.** ESLint `consistent-type-definitions: "type"`
and the assertion rules at error across the base, tests, and type-tests scopes.
The contract kit owns shared Zod wire schemas. Application packages own their
request and response schemas. `unparsed-boundary-reads` and
`duplicate-wire-schemas`: not yet held; the doctor's signals of those names are
the planned checks, both report-only at first.

Essay: [DAD.md](../DAD.md#disorganized-attachment)

## Enmeshment

**Definition.** One file or one function holds more than one responsibility, so
nothing inside it can be named, moved, or replaced on its own. This entry owns
size and undivided responsibility; a small unit with no published contract
belongs to [failure to launch](#failure-to-launch).

**Test.**

1. Does any source file exceed 400 counted lines, or any test file 600?
   (`files-over-ceiling`, `test-files-over-ceiling`: counted lines are
   non-blank and non-comment; any file over is a yes.)
2. Does any production function exceed complexity 10, 20 statements, depth 3,
   or 2 nested callbacks? (`functions-over-ceiling`: any of the four is a yes.)
3. Does a package's `src/index.ts` contain a statement that is not
   `export ... from`? (`barrel-impurity`: any such statement is a yes.)
4. Is there an import cycle inside a package?
   (`intra-package-cycles`: any cycle is a yes.)
5. In Rust, is there a `#[cfg(test)] mod tests` outside `tests.rs`, or an
   `#[allow(clippy::` mark in production?
   (`rust-inline-tests`, `clippy-allows`: any occurrence is a yes.)

**Cure.** One responsibility per file, with a counted-line ceiling per file and
per function that only ever moves down; splitting is the only way past it.

**Held in this repository by.** `dad doctor --gate` holding the
`files-over-ceiling` (400), `test-files-over-ceiling` (600), `barrel-impurity`,
`rust-inline-tests`, `clippy-allows`, `functions-over-ceiling`, and
`intra-package-cycles` ceilings; ESLint `complexity` 10, `max-depth` 3,
`max-statements` 20, `max-nested-callbacks` 2; `clippy::too_many_lines` at
`deny`, threshold 100.

Essay: [DAD.md](../DAD.md#enmeshment)

## You are looking for a father figure

**Definition.** The codebase takes its vocabulary from a vendor or from
precedent rather than owning it: a framework defines the shape a `core` package
is written in, a domain type aliases a vendor type, or the authority for a
decision is an old pull request and a document nobody has checked against the
code. The vendor implements a capability and is also allowed to define it.

**Test.**

1. Does a `core` package import a framework or ORM — nest, express, fastify,
   koa, hapi, prisma, drizzle, typeorm, sequelize, mongoose, knex?
   (`framework-in-core`: any such import is a yes.)
2. Does any domain type extend or alias a vendor type?
   (`vendor-named-domain`: a base type from a vendor package is a yes.)
3. Is a document that cites code untouched for longer than the profile's
   threshold while the code it cites changed?
   (`stale-docs`: 180 days standard, 90 strict.)
4. Does a package with no recorded invariants have one author holding more than
   80% of its commits? (`scripture`; heuristic, report-only. Proxy for
   authority living in a person rather than a document.)
5. Does a renderer in a package that uses a copy catalog write
   customer-visible words inline? (`hardcoded-ui-copy`: a literal at a visible
   seam that is not a copy key, data token, code, or path is a yes; packages
   without a catalog are not asked.)

**Cure.** `core` names the capability in its own words and the kind matrix keeps
vendors out of it; every rule that matters is a program, not a precedent.

**Held in this repository by.** The kind matrix in
`check-dependency-boundaries.mjs`: `core` may depend only on `core` and
`artifact`. `check-markdown-links.mjs` catches a citation whose target is gone,
though it follows paths and not anchors. `vendor-named-domain`, `stale-docs`,
`scripture`: not yet held; the doctor's signals of those names are the planned
checks.

Essay: [DAD.md](../DAD.md#you-are-looking-for-a-father-figure)

## You repeat the cycle

**Definition.** Access control is reinvented per feature instead of being asked
of one model: a tenant column compared in a `WHERE` clause, a role `if`-ladder,
an `authorize`-shaped function in a feature package. This entry owns access
decided by the wrong mechanism; a relationship never recorded at all — no
ownership tuple, no denial test — belongs to
[commitment issues](#commitment-issues).

**Test.**

1. For every table or column named like a tenant — `organization_id`,
   `tenant_id`, `account_id`, `workspace_id` — is it used as the access check
   in a `WHERE` clause rather than a relationship lookup?
   (`tenant-column-authorization`: any such clause is a yes.)
2. Does an `if` or `switch` branch on a role outside the authorization model?
   (`role-if-ladders`: any such branch is a yes.)
3. Is a function named `authorize*`, `can*`, or `isAllowed*` defined outside
   the authorization package? (`per-feature-authorization`: any is a yes.)
4. Does a route carry no access declaration? (`latchkey-routes`, cross-listed
   from [avoidant attachment](#avoidant-attachment).)
5. Is there a `console.*` call outside scripts and tests, or a directory named
   `helpers/`, `utils/`, `common/`, `misc/`, or `shared/`?
   (`console-in-production`, `junk-drawer-directories`: either is a yes.)

**Cure.** Access is a relationship check against one authorization model and no
feature package declares its own; a directory with no owner is not a place to
put code.

**Held in this repository by.** The access kit defines relationships and
permissions, and HTTP routes use typed permission handles. ESLint applies
`no-console` in production. Doctor reports the remaining signals.

Essay: [DAD.md](../DAD.md#you-repeat-the-cycle)

## You let the babysitter raise them

**Definition.** The rules governing a change live where no automated
contributor will read them. An agent edits with an author's permissions and
obeys what the repository enforces, not what a document asserts. The failure is
a rule that exists only as prose: absent, over budget to read, or with no
edit-time guard behind it.

**Test.**

1. Is there no agent entrypoint — `AGENTS.md` or equivalent — at the repository
   root? (`agent-entrypoint-missing`: absence is a yes.)
2. Do the entrypoint or the skills exceed their recorded token budgets?
   (`entrypoint-over-budget`: any file over its budget is a yes.)
3. Is no edit-time guard wired for any agent harness?
   (`agent-hooks-unwired`: no harness configuration invoking a guard is a yes.)
4. Is there a file `dad orient` cannot assign to an owning package?
   (`orphan-paths`: any unassignable path is a yes.)

**Cure.** The house rules are one entrypoint under a measured budget, and the
same checks run at edit time, at commit, and in CI.

**Held in this repository by.** [`AGENTS.md`](../AGENTS.md) with
`check-instruction-budgets.mjs` against `.agents/instruction-budgets.json`;
`scripts/agent-guards/` (`check-after-edit.mjs`, `guard-protected-files.mjs`,
`guard-shell-commands.mjs`) wired into `.claude/settings.json` and
`.cursor/hooks.json`; `.githooks/pre-commit` and `.githooks/pre-push`.
`orphan-paths`: not yet held; the doctor's `orphan-paths` signal is the planned
check.

Essay: [DAD.md](../DAD.md#you-let-the-babysitter-raise-them)

## People-pleasing

**Definition.** The response shape grows to satisfy each caller rather than
holding one contract: a denial that explains itself, a field added because a
client asked, a route returning more than one shape. Each addition is small and
none is removed, so no consumer can rely on which version it has.

**Test.**

1. Does any route return 403? (`forbidden-403`: a denial distinguishing "exists
   but forbidden" from "not found" is a yes.)
2. Does a denial response carry a message beyond the envelope?
   (`denial-with-body`: any body on a denial is a yes.)
3. Is a route's output a union, or does its handler return more than one shape?
   (`multi-shape-responses`: either is a yes.)
4. Is the share of optional fields in output schemas above the profile's
   threshold? (`optional-creep`: report-only standard, 50% strict.)
5. Does a `@deprecated` export still have importers?
   (`deprecated-still-consumed`: any importer is a yes.)
6. Does a published request shape use `z.object` or `z.looseObject` without a
   comment naming the authority that allows it? (`loose-contract-objects`: in
   a contract package or a module that declares routes, outside a response
   position, and with no `foreign-spec:` or `response-shape:` comment above it,
   is a yes.)
7. Does a renderer show a failure's raw message instead of copy it chose for
   the failure's code? (`raw-errors-in-ui`; heuristic. Proxy: a failure-named
   value's `message`, read, destructured, or stringified.)

**Cure.** One output schema per route, one envelope, and a denial that returns
404 with no body; the shape is the contract, so a change to it is a diff.

**Held in this repository by.** the contract kit owns the envelope and pagination schemas, and the HTTP kit owns typed transport errors; `npm run api-report:check` fails with the diff
when an exported surface changes. Every signal above: not yet held; the
doctor's signals of those names are the planned checks.

Essay: [DAD.md](../DAD.md#people-pleasing)

## You stay with people who cannot meet you

**Definition.** A dependency constrains the codebase more than the codebase
constrains it: a peer dependency dictating the runtime, a transport library
reached outside the one package binding it, several packages opening one
database client, or a package with no responsibility accumulating importers.
Distance does not fix this; only a contract does.

**Test.**

1. Does any peer dependency pin engines or a Node version?
   (`controlling-peers`: any such pin is a yes.)
2. Is fastify or express imported outside the http-server adapter?
   (`transport-at-root`: any other importer is a yes.)
3. Does more than one package open the same database client?
   (`shared-database`: two packages constructing one client is a yes.)
4. Is there a package named `shared`, `common`, or `utils` with more than three
   importers? (`shared-catchall`: a fourth importer is a yes.)
5. Has any dependency's last publish been more than 24 months ago?
   (`unmaintained-dependencies`: needs the network; without `--online` it
   reports not measured rather than zero.)

**Cure.** Every vendor enters through one adapter package that names it, and
the kind matrix makes reaching around that package a build failure.

**Held in this repository by.** The `imports` and `declared-dependencies` gates
of `check-dependency-boundaries.mjs` against each package's
`allowedDependencies`, with the `adapter` kind confining a vendor to one
package — which is what holds `transport-at-root`. The other four: not yet
held; the doctor's signals of those names are the planned checks.

Essay: [DAD.md](../DAD.md#you-stay-with-people-who-cannot-meet-you)

## Commitment issues

**Definition.** A relationship the code depends on was never written down: a
row created without its ownership tuple, a permission left as a TODO, a
mutation with no denial test, a package whose test count can fall unnoticed.
This entry owns the missing record and the missing proof; access implemented by
the wrong mechanism belongs to [you repeat the cycle](#you-repeat-the-cycle).

**Test.**

1. Does a create route write no ownership tuple and carry no ownership proof?
   (`mutations-without-ownership`: any creator without one is a yes.)
2. Is there a TODO or FIXME mentioning permission or auth within twenty lines
   of a route, or older than the profile's threshold?
   (`todo-check-permission`, `todo-age`: 30 days strict.)
3. Does a package with protected routes have no denial test or denial proof?
   (`denial-tests-zero`: any such package is a yes.)
4. Is any `it.only`, `it.skip`, or `it.todo` present?
   (`skipped-tests`: any occurrence is a yes.)
5. Has any package's passing test count fallen below its recorded floor?
   (`test-count`: a count under the floor is a yes; nothing measured is
   reported as not measured, never as zero.)
6. Does a package that publishes a generated access schema have no test proving
   a denial? (`access-without-denial-test`: any such package is a yes.)
7. Does a function insert a row and write its relationships as a separate
   step? (`sequential-authz-writes`: an insert beside `writeRelationships`, or
   beside the outbox's row-less `append`, is a yes.)

**Cure.** A mutation writes its ownership tuple and proves a denial by executing
one, and the passing test count per package is a floor that may only rise.

**Held in this repository by.** The strict profile's `strict/ownership-proof`,
`strict/denial-proof`, and `strict/authorized-list-proof` rules, whose proofs
are minted only by an executed run, for an adopting application;
`dad doctor --gate` holding the `test-count` and `type-test-negative-cases`
floors per package, and the `skipped-tests`, `denial-tests-zero`, and
`todo-check-permission` ceilings; ESLint `no-restricted-syntax`, leaving
`it.skipIf(condition)` as the only environment gate. `todo-age` is report-only
in `standard` and gated at zero in `strict`.

Essay: [DAD.md](../DAD.md#commitment-issues)

## Gaslighting

**Definition.** A violation is renamed until it is allowed: a recorded
exception whose reason does not say what it is, an exemption glob covering
hand-written code, a suppression with no description, a ratchet mark that moved
up. This entry owns the record that misrepresents; a record that is honest but
never shrinks belongs to [the silent treatment](#the-silent-treatment).

**Test.**

1. Does any ratchet baseline entry have an empty or boilerplate reason?
   (`baseline-entries-without-reason`: a missing `reason` field is a yes.)
2. Does a baseline exemption cover anything beyond generated files?
   (`exempt-globs`: any glob reaching hand-written source is a yes.)
3. Is there an `eslint-disable` with no reason, or a `@ts-expect-error` whose
   description is under ten characters?
   (`suppressions-without-description`: either is a yes.)
4. Does the baseline's history contain a diff where a ceiling mark went up or a
   floor came down? (`marks-raised-in-history`: either move is a yes.)
5. Was a migration the base line already holds modified, deleted, or renamed
   by a commit past the base? (`migrations-edited`: any such commit is a yes. A
   draft that is not on the base yet may change freely. The base is
   `origin/main`, else `main`; with neither, every change after a migration's
   first commit counts, and the report says so.)
6. Was a generated table module or a generated access schema changed in a
   commit that changed nothing it is generated from?
   (`generated-tables-hand-edited`, `generated-access-hand-edited`: either is a
   yes; a brand annotation added to an existing column is the one allowed
   hand edit.)

**Cure.** Every exception carries a reason and the baseline may only ever move
toward its threshold; the comparison against a git ref, not trust, enforces it.

**Held in this repository by.** `dad doctor --gate`, through
`check-source-budgets.mjs`: an entry with no `reason` is an error in every mode
including `--base`; `--update` writes only downward; `--base <ref>` fails on any
loosening, a removed floor included; a floor may fall only where its entry's
`movedTo` names the key its count went to and that key rose by at least the fall
in the same change, which both `--base` and `marks-raised-in-history` read as a
move rather than a loosening; `marks-raised-in-history` and
`baseline-entries-without-reason` are gated at zero, and the one mark this
repository's history did raise is a recorded exception with a reason and a date.
ESLint `ban-ts-comment` requires a description of at least ten characters.

Essay: [DAD.md](../DAD.md#gaslighting)

## The silent treatment

**Definition.** The compiler or the linter reported something and the report
was silenced rather than answered. A suppression record exists and nothing
about it is required to shrink. This entry owns the standing, unmoving
suppression; the hatch written in line belongs to
[daddy issues](#daddy-issues), and an exception whose stated reason is false
belongs to [gaslighting](#gaslighting).

**Test.**

1. Does the suppressions file hold more entries than its recorded ceiling?
   (`suppressed-violations`: any count above the mark is a yes.)
2. Is any suppression older than 90 days with no downward move?
   (`suppression-age`: report-only standard, 0 strict.)
3. Does the suppressions file list a rule and file that no longer produce a
   violation? (`unused-suppressions`: any stale entry is a yes.)
4. Is there a `@ts-ignore`, a `@ts-nocheck`, or a `@ts-expect-error` outside
   `type-tests/`? (`ts-suppressions`, cross-listed from
   [daddy issues](#daddy-issues).)

**Cure.** An exception is written down, dated, given a reason, and only ever
allowed to shrink; the record is written and read by the tool, never by hand.

**Held in this repository by.**
[`eslint-suppressions.json`](../eslint-suppressions.json), written and read by
ESLint itself and Prettier-ignored; `npm run lint:prune`, which removes entries
no longer needed, while `npm run verify` never regenerates them;
`dad doctor --gate` holding the `ts-suppressions`, `eslint-disables`,
`unused-suppressions`, and `suppressions-without-description` ceilings at zero.
`suppression-age` is report-only in `standard` and gated at zero in `strict`.

Essay: [DAD.md](../DAD.md#the-silent-treatment)

## Failure to launch

**Definition.** A unit of behavior never acquired a contract of its own: logic
stays in the route handler that received it, the package publishes no surface
report, a list route takes no query schema, an application asserts no profile.
Reorganizing folders does not change this; only extracting a contract does.
Size and undivided responsibility belong to [enmeshment](#enmeshment).

**Test.**

1. Does a route handler exceed the profile's statement threshold, or import
   persistence directly? (`logic-in-controllers`: 20 statements standard, 10
   strict; either is a yes.)
2. Does a package declaring `publishConfig` have no api report?
   (`packages-without-surface`: any such package is a yes.)
3. Does a list route have no query schema?
   (`lists-without-filter`: any unfiltered list route is a yes.)
4. Does an application with routes make no strict-profile assertion?
   (`strict-profile-absent`: report-only standard, 0 strict.)
5. Is the share of rename-only commits in the last 90 days above the profile's
   threshold? (`reorganization-churn`: report-only standard, 20% strict.)

**Cure.** Behavior gets a named owner with a published surface, and the surface
report is regenerated in the same change that alters it.

**Held in this repository by.** `npm run api-report:check`, which fails with the
diff for every package declaring `publishConfig`. The HTTP kit and the
application tests prove access and response behavior. Doctor reports
`logic-in-controllers`, `lists-without-filter`, and `reorganization-churn`.

Essay: [DAD.md](../DAD.md#failure-to-launch)

## “It’s not you. It’s my boundaries.”

**Definition.** No mechanism exists that could stop a change from crossing a
boundary: kinds undeclared, hooks not installed, no workflow running the gate,
rules resolving at `warn`, strictness flags off, or the gate bypassable from
the shell. This entry owns missing or bypassable enforcement; a crossing that
happened belongs to [anxious attachment](#anxious-attachment), and a rule that
exists but cannot justify itself belongs to
[Dad has issues too](#dad-has-issues-too).

**Test.**

1. Does any package declare no `kind`? (`kinds-undeclared`: a missing or
   unrecognized kind is a yes, and fails the measure rather than counting zero.)
2. Is `core.hooksPath` unset, or are the hooks it names missing?
   (`hooks-not-wired`: either is a yes.)
3. Does no CI workflow run the gate?
   (`ci-without-verify`: no workflow invoking the verify command is a yes.)
4. Does `eslint --print-config` resolve any rule at `warn`?
   (`rules-at-warn`: any rule not at error is a yes.)
5. Is any strictness flag from the base list missing from the compiler
   configuration? (`compiler-flags-off`: any missing flag is a yes.)
6. Does `--no-verify` appear in a script, document, or workflow, or does any
   workflow force-push the default branch?
   (`no-verify-in-scripts`, `force-push-in-workflows`: either is a yes.)
7. Does response code spread, return, or send a whole row, or bind an object
   rest, instead of naming each field it sends? (`rows-sent-whole`; heuristic.
   Proxy: a value named `row`, `record`, or `…Row`/`…Record`.)

**Cure.** The declaration is one file, every rule is an error or is not a rule,
and the same gate runs at edit time, at commit, at push, and in CI, with the
bypass denied before the shell sees it.

**Held in this repository by.** [`dads.project.json`](../dads.project.json)
declares every package's `kind`; [`tsconfig.base.json`](../tsconfig.base.json)
is the only place strictness is declared; the `lint-rules` floor (439
error-level rules) fails when a rule disappears or drops to `warn`;
`npm run prepare` sets `core.hooksPath` to `.githooks`, `.githooks/pre-push`
runs `npm run verify`, and `.github/workflows/verify.yml` runs that same job;
`scripts/agent-guards/guard-shell-commands.mjs` denies `--no-verify` and
force-pushing `main`.

Essay: [DAD.md](../DAD.md#its-not-you-its-my-boundaries)

## The paper wall

**Definition.** A boundary is a contract the codebase owns, written in its own
vocabulary, implemented by a provider chosen once at the composition root. A
wrapper is a module that renames a vendor while the vendor's types, errors, or
identifiers still cross it. The test of a real boundary is that an in-memory
provider can pass the same conformance suite as the vendor. This entry owns the
boundary that was announced and does not hold; a vendor imported where no
boundary was attempted belongs to [anxious attachment](#anxious-attachment).

**Test.**

1. Does a package presented as an adapter, port, or boundary have no
   conformance suite that more than one provider runs?
   (`wrapper-without-conformance`: an `adapter` package with no suite shared
   with another provider is a yes.)
2. Does a capability have exactly one implementer and no in-memory stand-in?
   (`no-in-memory-provider`; cross-listed with
   `single-implementer-abstractions`.)
3. Does a vendor type, error, or identifier appear in the emitted surface on
   the consumer side of the boundary? (`vendor-types-in-surface`, cross-listed
   from [anxious attachment](#anxious-attachment).)
4. Is the provider constructed anywhere other than the composition root?
   (`provider-chosen-outside-root`: a vendor client constructed inside a
   handler or a domain module is a yes. A binding can construct libraries named
   in its own `allowedDependencies`.)

**Cure.** `core` defines the capability in its own words, at least two providers
implement it, and one conformance suite runs against both; a provider that
cannot be stood in for in memory has not been bounded.

**Held in this repository by.** The [access kit](../packages/access/README.md)
defines policies. [Postgres access](../packages/server/postgres-access/README.md)
runs the same permission worlds against PostgreSQL and SpiceDB. The HTTP test
app supplies an in-memory authorization fake for request-level checks.

[Contract schemas](./validation.md) are shared by the HTTP kit and request
transport. [HTTP hosting](./http-hosting.md) runs the same route pipeline in
application tests and on a listening server.

The [path aliases package](../packages/testing/path-aliases/README.md) has a
file system port with Node and in-memory providers. Both run the resolver
conformance suite, and the Vitest adapter uses the same resolver.

Essay: [DAD.md](../DAD.md#the-paper-wall)

## Dad has issues too

**Definition.** The enforcement itself becomes the failure: a rule that cannot
name the change it stops, a warning nobody reads, a guard that blocks when its
own tool is missing, a ceiling raised whenever something hits it, an exception
whose mark never moves. This entry owns the rule that is unfalsifiable,
unexplained, or permanent; a rule that is missing belongs to
[“It’s not you. It’s my boundaries.”](#its-not-you-its-my-boundaries).

**Test.**

1. Does any lint rule resolve at `warn`? (`rules-at-warn`, cross-listed from
   [“It’s not you. It’s my boundaries.”](#its-not-you-its-my-boundaries).)
2. Has any threshold been raised, or any floor lowered, in the baseline's
   history? (`thresholds-raised`, cross-listed with `marks-raised-in-history`
   under [gaslighting](#gaslighting).)
3. Does any guard block a change when its own tool is missing, rather than
   failing open? (`guards-fail-closed`: a guard exiting non-zero on a missing
   binary is a yes.)
4. Is any baseline entry older than the profile's threshold whose mark never
   moved? (`stagnant-debt`: 180 days standard, 90 strict.)
5. Does any generated file churn without its input changing?
   (`nondeterministic-generated-files`: a commit changing only a generated file
   is a yes.)
6. How much of the runtime budget do local Git hooks typically use?
   (`hook-runtime` reports recent median durations.)
7. Does any rule fail to name the change it stops, or ship without a case that
   trips it? (heuristic. Proxy: a rule with no fixture and no `reason` naming a
   concrete change is a yes.)

**Cure.** Every rule names the change it stops and ships with a case that trips
it; nothing sits at `warn`; a missing tool fails open; and every ratchet entry
carries a reason and a direction it must move.

**Held in this repository by.**
[`.agents/source-budgets.json`](../.agents/source-budgets.json), where every
entry carries a `reason` and no mode raises a mark; `scripts/agent-guards/`,
which fails **open** when a tool is missing and closed only on unreadable hook
input, as the ratchet wrapper does for one file when the doctor is not built;
the `lint-rules` floor; `npm run verify` being the whole of CI, and the gate it
runs being `dad doctor --gate`, the product rather than a private copy.
`stagnant-debt` is gated at 180 days but reads a date only through `--today`, so
a run without one says it was not measured; `nondeterministic-generated-files`
is report-only in `standard`; no signal yet reads a decommission date.

Essay: [DAD.md](../DAD.md#dad-has-issues-too)
