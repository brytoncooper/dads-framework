# Dads agent operating model

The CLI can explain ownership, generate application code, and select and
run verification. [`dad-dev`](../packages/foundation/dev/README.md) can isolate
local services for Git worktrees. Task claims and overlap detection remain
product direction.

## The idea

Dads should teach contributors how to work responsibly inside a Dads
application.

A coding agent should not need tribal knowledge to determine where a change
belongs, which dependencies are permitted, how authorization is expressed, what
tests are credible, or whether another task owns the same files. The framework
already has the information required to answer many of those questions; its
developer toolbox should present that information as a usable operating model.

The goal is not to make agents autonomous by adding a large prompt. The goal is
to make bounded, correct work the easiest recognizable path.

## One source of truth, several teaching surfaces

Architecture policy, framework metadata, and project declarations are the source
of truth. Dads derives several interfaces from them:

- Human documentation and short task guides.
- Agent instructions for supported harnesses.
- Task-specific playbooks and generators.
- CLI explanations and suggested verification commands.
- Machine-readable diagnostics for automated agents.

An instruction adapted for Codex, Claude, Cursor, or another harness may differ
in format. It must not redefine the rule. A contributor who never loads an agent
skill must still encounter the same boundary through the compiler, policy
checker, tests, or completion gate.

Skills are therefore an adoption layer over the framework. Dads should
select and rewrite only the skills that teach its actual operating model rather
than importing every workflow that happens to exist in the origin application.

## What the framework should teach

### Placement and ownership

- Find the capability or domain that owns the meaning.
- Distinguish contracts, pure behavior, operations, integrations, transport
  edges, and composition.
- Define consumer-owned seams for behavior needed from another domain.
- Keep foreign dependencies and their types inside declared integrations.

### Authorization

- Declare entities, legal relationship targets, and permissions once in the
  owning access module. Use those typed handles throughout application code.
- Keep string identities at transport, persistence, artifact, and vendor
  boundaries; bind them once to canonical model handles.
- Declare access explicitly for every operation. Use the supported single
  relationship check or authorized-list path.
- Write required ownership relationships when resources are created.
- Prove denial and missing-relationship behavior, not only the allowed path.

### Testing and proof

- Run pure tests for decisions and operations.
- Run the capability's reusable conformance suite against every implementation.
- Run integration tests against each real foreign dependency.
- Run composition tests for the selected bindings.
- Reserve end-to-end tests for critical assembled journeys.
- Report unperformed checks honestly rather than treating a narrower green check
  as proof of the whole system.

Dads should be able to inspect a change and recommend the relevant proof
without making an agent memorize every command. The recommendation must explain
why each test applies and remain overridable when the project declares a more
specific requirement.

Recommendation and verification are different states. `test:recommend` names
candidates. `verify` executes providers and then reports each consumer as
executed, reused, failed, blocked, or not applicable. Reuse is permitted only by
the controlled task contract with an exact local receipt for an immutable input
snapshot. Live services, shell tasks, secrets, and unknown inputs always run.

## Parallel work without collisions (next capability)

Parallelism should follow independently owned work rather than placing several
writers in one mutable checkout.

The optional agent toolbox should support:

1. Creating an isolated worktree or task workspace for each writing task.
2. Recording the task's intended packages, capabilities, or files.
3. Warning when two active tasks claim overlapping ownership.
4. Sharing read-only caches and expensive development services where safe while
   keeping mutable source and test data isolated.
5. Detecting overlapping edits again before integration.
6. Integrating through explicit review and verification rather than copying one
   task over another.

File claims are coordination signals, not locks that make unsafe edits correct.
Git history, isolated workspaces, boundary checks, and tests remain the durable
proof. A stale task claim must be visible and recoverable.

The toolbox should also avoid resource collisions. It should coordinate ports,
container project names, databases, watchers, and long-running test processes so
two agents do not accidentally share mutable state or start duplicate stacks.

## Implemented command experience

```text
dad orient <path>
dad explain <path>
dad inspect http-operation "GET /tenants/:tenantId/notes"
dad add --help
dad add endpoint <name> --domain <domain> --api <api>
dad check boundaries
dad test:recommend --changed
dad verify --changed
dad skills:sync
```

Interactive output should be readable by a person. A stable structured-output
mode should expose the same task state, recommendations, diagnostics, and proof
results to agents without requiring them to scrape terminal prose.

Use `--json` on inspection, generation, and verification commands when a
machine consumes the output. Use `dad-dev status` to inspect worktree service
slots. Task lifecycle and ownership claims are proposals.

## Relationship to the development environment

Task isolation and environment operation should work together. A task workspace
should be able to attach to shared immutable images and caches while receiving
its own routing identity, writable volumes, databases, and watcher processes
where isolation matters.

An agent should be able to start the declared environment, wait for readiness,
inspect sanitized logs, run the recommended tests, and shut down only the
resources its task owns. See
[development-environment.md](./development-environment.md).

## Current proof and remaining proof

The HTTP 0.1 workbench and benchmark fixtures prove that:

- A new agent can identify the owner and supported workflow for a small change.
- The framework returns the focused verification declared by every affected
  package and explains why that package is affected.
- Canonical task skills remain identical across supported agent harnesses and
  stay within enforced context budgets.
- The same workflow is usable manually without an AI agent.
- A protected artifact consumer can reuse exact prior proof after source-only
  policy refactoring while policy, consumer, test, engine, binding, config,
  lockfile, toolchain, and environment changes independently force execution.
- Optimized and explicit full verification detect the same injected consumer
  failure in the supported boundary fixture.

Still required for the parallel-work capability:

- Two writing tasks use isolated workspaces and cannot silently overwrite one
  another.
- An intentional ownership overlap is reported before integration.
- Ports, databases, watchers, and long-running services are isolated or shared
  according to an explicit environment contract.
- Test recommendations distinguish pure, conformance, integration, composition,
  and end-to-end proof from project declarations instead of only returning the
  package's focused verification command.

## Non-goals

This capability does not initially attempt to:

- Replace git, code review, CI, or a team's issue tracker.
- Coordinate arbitrary work across unrelated repositories.
- Guarantee that generated code or agent output is correct without tests.
- Give agents permission to bypass framework rules or destructive-action
  safeguards.
- Require a particular agent vendor.
- Copy every existing skill from the origin application into Dads.
- Build a hosted multi-team agent control plane before local workflows are
  useful.

## Recommended build order

1. Measure setup mistakes, test mistakes, and edit collisions in real use.
2. Implement isolated workspaces and overlap detection with two concurrent
   writing tasks.
3. Coordinate task-owned ports, databases, watchers, and services with the
   development-environment contract.
4. Add task start, status, and finish commands only after that proof is stable.
