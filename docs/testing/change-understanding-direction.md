# Dads Testing: change understanding before execution

Status: accepted product direction; the analysis prototype below is planned.
Date: 2026-09-05.
Scope: Dads Testing within `dads-framework`. This decision does not redefine
the framework's HTTP, authorization, or other capabilities.

## Decision

**Dads Testing understands code changes, determines the checks and builds they
require, and schedules and runs that work through a repository's existing
tools. Its next prototype proves change understanding before expanding execution.**

The engine remains language agnostic. JavaScript and TypeScript are the first
language integration. Users should not need Nx, named projects, declared tasks,
or a Dads manifest for supported source analysis.

This record defines the agreed product and development sequence. Existing
[quickstart](./quickstart.md) and [soundness evidence](./README.md) documentation
describe the currently implemented task-based product. This decision does not
make the proposed analysis interface available or change current release gates.

## Purpose and users

Developers, reviewers, coding agents, and automated checks need to understand
the consequences of a change beyond its local diff. Given a repository and a
comparison, Dads should answer:

- What files, declarations, types, exports, or configuration inputs changed?
- What code depends on them, directly and transitively?
- What may be affected, through which relationships?
- Which conclusions are supported, and where does understanding stop?
- Eventually, what work is justified, and how should it be executed?

A repository with source files but no tests or task definitions must still
receive a useful impact report. An affected item means its correctness or
behavior may depend on the change. It does not mean Dads has proved that its
behavior changed, or that an existing test will fail.

## Product boundary

The complete product has two stages:

1. **Understand change.** Establish the compared source states, interpret the
   edits, follow relevant dependencies, and produce an explained impact result.
2. **Drive work.** Discover available checks and builds, translate impact into
   safe execution scopes, preserve prerequisites, schedule compatible work,
   invoke existing tools, and collect results.

Both stages belong to Dads Testing. The first must work independently so its
correctness can be measured before task selection or execution hides gaps.

The eventual execution layer drives test runners, linters, typecheckers, build
tools, and repository detectors. Test selection is at whole test-file level;
selecting individual `it()` or `test()` cases is outside the agreed scope.
Execution may group compatible files while preserving their runner settings
and individual evidence.

Different checks require different scopes. File-local lint rules, typed lint
rules, runtime tests, compiler programs, generated outputs, and detectors do
not all have the same dependency semantics. An affected type is analysis
information; the compiler integration must still choose a valid checking
context. A detector can require surrounding unchanged code to evaluate a rule.

Project boundaries and task declarations are optional inputs when present.
TypeScript configurations, package metadata, and build configurations retain
their own meaning. Dads may internally represent runnable work as tasks, but
users should not have to recreate existing structure as Dads declarations.
Nx can be an optional metadata or compatibility integration. It must not be
required to analyze a repository or become authoritative for the core engine.

For supported ordinary setups, the target is no additional Dads configuration:
read the existing source and tool configuration. Custom launchers, external
services, generated inputs, or ambiguous configuration may require an explicit
integration or additional information. Such gaps remain visible; they do not
silently disappear from the discovered scope.

## Language and integration architecture

Language integrations contribute facts to a shared change-impact model.
Framework and tool integrations can contribute relationships that ordinary
language analysis cannot establish. Consumers use the same model for reports
and, later, execution planning.

| Layer                         | Owns                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language integration          | Parsing, name and module resolution, language-specific change interpretation, declarations, references, dependency meaning, and unsupported constructs. |
| Shared engine                 | Source identities, graph storage and updates, propagation over supported relationship kinds, evidence, uncertainty, and impact reports.                 |
| Framework or tool integration | Additional facts from templates, configuration, code generation, test discovery, or other conventions.                                                  |
| Execution layer, later        | Mapping impact to valid check scopes, prerequisites, ordering, concurrency, batching, processes, and result collection.                                 |

Each new language requires its own understanding layer and correctness corpus.
It should reuse graph storage, traversal, reporting, and scheduling. A parser
alone is insufficient: the integration must preserve the language's dependency
and change semantics. Language-specific compiler or parser objects stay inside
their integration; shared facts carry stable identities and source locations.

The shared model must distinguish relevant dependency kinds instead of reducing
everything to an unqualified file edge. Runtime, type, configuration, and
generated-input relationships are initial requirements to shape against concrete
examples. The exact schema and propagation rules remain implementation design
work; this document does not declare them implemented or universally sufficient.

Cross-language and framework connections require evidence too. Unknown behavior
must remain explicit. A small second-language example should later test whether
the shared contract can accommodate another language without duplicating the
engine; broad second-language support is not the next prototype's prerequisite.

## Next prototype: an independent impact report

The prototype accepts a repository and an explicit comparison, normally supplied
by Git. It analyzes ordinary JS/TS source and supported existing configuration
without requiring project ownership or executable task declarations. It does
not schedule application tests, linters, builds, or custom verification commands.
Tests of the analyzer itself remain necessary.

Its result must carry these concepts. Names below describe required information,
not a finalized API or a new CLI command:

| Information             | Required meaning                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comparison identity     | The before/after source states, relevant configuration and dependency inputs, analyzer versions, and analyzed scope. A commit alone does not describe dirty source. |
| Changed items           | Added, modified, removed, and renamed paths; affected declarations and locations in the relevant source version; unattributed edits.                                |
| Potential impact        | Direct and transitive affected files and supported symbols, preserving dependency kinds.                                                                            |
| Explanation             | The changes and dependency paths supporting each finding, with source evidence where available.                                                                     |
| Uncertainty             | Unresolved or unsupported relationships, their reasons and locations, and the scope that cannot be proven unaffected.                                               |
| Coverage and completion | What was analyzed, omitted, unsupported, or unavailable, and whether the requested analysis completed.                                                              |

The report must support machine consumption and a readable explanation. Stable
ordering and identities must make repeated equivalent analyses comparable.
Precise findings and broader uncertain areas may coexist in one report.

### Result behavior

- **Supported change:** report changed items, reached consumers, and explanations.
- **No change:** explicitly report no changes for the identified comparison.
- **No discovered consumers:** distinguish that observation from proof that no
  consumers exist; state the analyzed scope and any unresolved relationships.
- **Partial understanding:** retain established facts, mark the gaps, and widen
  the potentially affected scope. Unknown ownership cannot require an invented
  project declaration before the report can express uncertainty.
- **Unavailable input, invalid comparison, or interrupted analysis:** report an
  incomplete or failed analysis. It must not resemble a successful empty result.
- **Source changes during analysis:** detect inconsistent inputs and reject or
  retry against a consistent state; do not claim one report describes both states.

The initial proof matrix should cover ordinary JS/TS declarations and imports,
direct and transitive consumers, independent controls, named re-exports,
type-only dependencies, additions/removals/renames, and configuration changes.
Ambiguous or unsupported cases need expected uncertainty outcomes. Existing
CommonJS, dynamic import, alias, and unresolved-import fixtures provide further
concrete cases; they are not evidence of exhaustive language support.

Historical comparisons must use the correct old and new source evidence. If a
comparison cannot be analyzed, the result must say so rather than attributing
its changes against a different working tree. Missing or stale graph data must
trigger rebuilding or an explicit incomplete result.

## Correctness and proof

The primary acceptance target is an accurate impact report against independently
established expectations. A passing command does not prove a dependency map is
complete. Likewise, selecting a broad set of tasks does not prove precise
symbol understanding.

For each fixture or recorded gap, retain:

1. The repository shape, language/tool versions, relevant configuration, and
   reproducible before/after source identity.
2. The mutation and expected changed items, connections, affected items,
   unaffected controls, and uncertainty scope.
3. The actual result, including explanations and unsupported areas.
4. Missed dependencies, unjustified precision claims, unnecessary inclusions,
   and invalid or incomplete observations.
5. Why the mismatch occurred, the responsible analysis boundary, and the
   regression or follow-up needed to repair it. If the cause is not known,
   record that explicitly rather than inventing a diagnosis.

Expectations must come from a separately authored model or reviewed example,
not from Dads' own output. Controlled execution can corroborate impact, but
observing no failing tests cannot establish that code is unaffected. Existing
execution-based soundness checks remain useful complementary evidence.

Skip eligibility always depends on supported evidence. Unknowns broaden impact;
missing observations never count as a pass. A claim of precision must name the
covered patterns and its evidence. General perfect precision for arbitrary
runtime behavior is not a product guarantee.

Dads aims for the smallest safely justified workload. Machine load and the
underlying tools prevent a universal wall-clock speed guarantee. Measure missed
impact, unnecessary scope, explanation correctness, and actual work. Timings
remain useful diagnostics. Harness baseline reuse and case concurrency remain
valuable only while preserving independent expectations and isolated evidence.

### Prototype acceptance criteria

- An ordinary JS/TS repository without Nx, a Dads manifest, named projects,
  declared tasks, or tests can produce a meaningful impact report.
- Analysis is callable independently of scheduling and does not launch the
  repository's verification commands.
- Every declared precision fixture matches its expected changed items, affected
  items, dependency paths, and independent controls; unexpected omissions or
  inclusions fail its precision claim.
- Every uncertainty fixture reports its expected reason and scope. No absence
  of evidence becomes a claim that the area is unaffected.
- Before/after evidence, deletion and rename handling, repeatability, stale
  snapshots, and incomplete or changing inputs have explicit regression proof.
- Runtime and type relationships are not silently treated as interchangeable.
- A readable explanation and machine-readable result agree on findings and
  completion. Their input scope and supported capabilities are inspectable.
- Real-repository gaps become sanitized, reproducible fixtures and recorded
  explanations. A private trial never substitutes for public release evidence.

## Checkpoint: source and existing evidence

This is a checkpoint of the development direction, not a release declaration.

- Repository: `dads-framework`.
- Branch at recording: `feature/testing-generator-foundation`.
- HEAD: `b96001357aa561a81780acc688ddc6a703f436e9`.
- Commit subject: `test(testing): prove CommonJS runtime and preserve removal fallback`.
- Working tree: existing uncommitted changes across analysis, snapshots,
  explanations, the soundness harness, integrations, and documentation.

The HEAD identifies the committed baseline only. The inspected implementation
and some evidence below include uncommitted work. Reproducing that checkpoint
requires its actual source snapshot; checking out this commit alone is not
sufficient. This document creates no new implementation commit.

### What exists

- [JS/TS extraction](../../crates/dads-testing-javascript/src/lib.rs) isolates
  Oxc and produces declarations, references, imports, resolved paths, and
  uncertainty facts.
- The [shared graph](../../crates/dads-testing-core/src/graph.rs) already exposes
  module and changed-export reachability, reached edges, and uncertainties
  without a project manifest argument. It is not a complete call graph or a
  general TypeScript type-impact engine.
- The [public native request path](../../crates/dads-testing-core/src/lib.rs)
  currently loads a manifest, assigns impact to projects, and plans tasks.
  Fallback policy is coupled to declared project dependencies. Exposing an
  independent report therefore requires policy work as well as an API boundary.
- [Graph snapshots](../../crates/dads-testing-store/src/lib.rs), Git change
  handling, explanations, the 21-case curated corpus, and deterministic generated
  cases provide reusable foundations. The generated cases currently model
  three-project chain or fanout arrangements.
- The [soundness harness](../../scripts/testing/testing-soundness.mjs) primarily
  compares declared task selections and observed outcomes. It includes exact
  selection and fallback checks for specified cases, but is not yet the full
  impact-report acceptance suite described above.
- The core keeps JS/TS parser dependencies outside it, but its shared vocabulary
  is currently module/import/export oriented. General suitability for multiple
  languages remains to be demonstrated.

### Bounded private trial

An isolated trial, referenced only by the alias **Harbor**, ran three existing
Vitest suites containing 27 runtime tests with Nx unavailable. A shared support
library was also included. The trial used a manually declared three-task manifest
and three isolated Vitest configuration changes; source and tests were preserved.

The baseline passed. Controlled source changes selected the provider and its
consumer, the consumer alone, the independent control alone, or all three when
shared support changed. Those selections agreed with independent execution of
the same bounded suites. An unchanged run executed nothing. Root configuration
and unknown-input changes selected all three in plan-only checks.

This establishes a small standalone execution proof. It does not establish
automatic discovery, general impact-report correctness, typechecking, complete
build orchestration, or full-repository compatibility. No full private-repository
suite ran. These are previously captured local observations, not tests rerun
while writing this decision.

Raw private evidence, source, names, namespaces, target inventories, and local
paths stay outside committed documentation and fixtures. Only sanitized examples
and explicitly bounded summaries belong here. Private trial evidence remains
outside the release gate described in [the evidence guide](./README.md).

## Sequence and tradeoffs

1. **Define the analysis contract and proof matrix.** Ground the concepts above
   in small before/after examples with independently reviewed expected results.
2. **Expose and prove standalone analysis.** Reuse the existing frontend, graph,
   and store; make uncertainty meaningful without declared project ownership.
   Add direct impact-report assertions to the existing fixture infrastructure.
3. **Deepen supported understanding.** Prioritize recorded gaps and realistic
   JS/TS patterns, then add framework facts and test the language boundary with
   a small second-language example. Expand claims only with evidence.
4. **Resume execution integration.** Begin with automatic discovery and whole
   test-file selection for Vitest, preserving its existing settings. Then extend
   to linting, typechecking, builds, and detectors at their valid scopes.

Scheduler and live Nx adapter expansion are deferred during the next prototype.
Existing implementation and regression proof remain available. The analyzer,
snapshot correctness work, and harness infrastructure are directly reusable;
execution work is downstream. The live Nx adapter was a detour from proving
standalone understanding and is optional compatibility work.

A standalone report is a bounded next step, but removing manifest dependence
requires deliberate fallback semantics. Deep language understanding remains
substantial work. The sequence avoids making runner setup the measure of
analysis progress while retaining concrete downstream examples as contract checks.

Alternatives considered:

- **Continue execution and Nx integration first:** gives end-to-end behavior,
  but spends effort on orchestration before the underlying impact result is
  independently proven. Deferred.
- **Only generate manifests automatically:** reduces setup effort while leaving
  the public analysis dependent on tasks. Insufficient for the agreed prototype.
- **Understand every language and framework before exposing a result:** has no
  bounded completion condition. Use explicit supported patterns and visible gaps.
- **Replace the current engine wholesale:** current separation provides reusable
  components. No evidence currently justifies a wholesale rewrite.

The next prototype does not promise exact behavioral equivalence, individual
test-case selection, universal framework support, automatic setup of arbitrary
external services, or a faster elapsed time on every machine. Exact CLI names,
wire schemas, additional language order, persistent test-result reuse, and detailed
scheduler implementation remain separate decisions.

## Documentation handoff

Begin implementation with independent expected impact reports, then carry
those cases through the first two steps in [Sequence and tradeoffs](#sequence-and-tradeoffs).
The existing [soundness gate](./README.md#release-gate) continues to cover the
task-based implementation while the prototype is evaluated.
