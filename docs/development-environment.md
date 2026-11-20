# Dads development environment

The [`dad-dev` package](../packages/foundation/dev/README.md) currently manages
worktree slots with separate ports, Postgres databases, and file roots. Use
its documented commands for those workflows.

For an existing Dads app with `dads.dev.json` and a local Postgres
maintenance connection, start with `dad-dev ready`, then run `dad-dev up`.
Inspect the assigned slot with `dad-dev status`. The kit starter ships its
own local stack and starts with `npm start`.
[Worktree setup](../packages/foundation/dev/README.md#try-it) ·
[Starter setup](../apps/kit-workbench/README.md#start)

The remaining sections describe the broader development-environment proposal.
The `dad dev:*` commands below illustrate that proposal.

## The promise

A developer or coding agent should be able to enter a Dads project and run
one obvious command to reach a declared ready state without learning a team's
private collection of setup scripts.

Conceptually:

```text
dad dev:up
```

The command should inspect the project, verify minimum host prerequisites,
acquire project-scoped dependencies and declared images, start required
services, apply safe initialization, configure local routing, start watchers,
and wait until the application reports readiness.

This is more than a Docker Compose wrapper. It is an executable environment
contract shared by local development, agents, CI, and deployment tools.

## The environment contract

A Dads application should be able to declare:

- Application processes and deployable components.
- Required databases, authorization engines, queues, object stores, and other
  services.
- Locked toolchain, dependency, and image versions.
- Build recipes and runtime entrypoints.
- Configuration schemas, required secrets, and safe local defaults.
- Startup order, migrations, seed operations, and readiness checks.
- Stable local routes and service-to-service names.
- Source watchers and the files that should trigger each one.
- Persistent, ephemeral, shared, and task-isolated volumes.
- Resource ownership and shutdown behavior.

The declaration should express what the application needs. Docker, another
container runtime, or host processes are implementations of that contract.

## Intended command experience

A coherent command family could include:

```text
dad dev:up
dad dev:status
dad dev:logs [component]
dad dev:doctor
dad dev:restart [component]
dad dev:down
dad dev:reset
```

`dev:up` should be idempotent: already-correct resources are reused, missing
resources are created, unhealthy resources are repaired or reported, and an
unexpected state fails with a useful explanation.

`dev:status` should report the declared state and actual state of every
component, including routes and readiness.

`dev:doctor` should diagnose host prerequisites, version drift, port conflicts,
missing configuration, unhealthy services, stale task resources, and image or
migration mismatches.

`dev:reset` is destructive and must show its exact owned targets before deleting
data. It must never treat a broad host directory or unrelated container as an
Dads-owned resource.

The same information should be available as stable structured output for agents
and automation.

## Dependency acquisition and host safety

Dads may automatically acquire dependencies that are scoped to the
project:

- JavaScript packages from the project's lockfile.
- Declared container images.
- Framework-managed toolchain archives or project-local binaries.
- Generated local certificates and routing configuration owned by the project.

It should not silently install Docker, change privileged networking, edit global
shell profiles, or mutate unrelated machine configuration. Missing machine-wide
prerequisites should produce one guided, explicit setup action with a way to
verify success.

This boundary keeps `dev:up` convenient without turning it into an opaque
machine administrator.

## Containers and framework components

Deployable application components should be able to produce consistent
Docker/OCI images from framework-supported build recipes. An image should carry
the built application and its runtime entrypoint; environment-specific
configuration and secrets are supplied at runtime.

Not every Dads package should become a container. Pure libraries,
contracts, policy packages, and test helpers remain ordinary packages. Images
belong to independently runnable components such as an API, worker, local guest
runtime, migration job, or separately hosted capability implementation.

Development may mount source and run watchers for fast feedback while production
runs an immutable image. Both paths should exercise the same component boundary,
configuration schema, startup contract, health behavior, and migration entrypoint.

## Routing, watchers, and readiness

The development environment should own the repetitive coordination teams
otherwise rebuild separately:

- Assign stable local names and routes without asking each developer to remember
  ports.
- Detect port conflicts before starting partial stacks.
- Start only the watchers required by the selected components.
- Restart the smallest affected process when source changes.
- Aggregate logs while preserving component identity.
- Wait for migrations and health checks rather than declaring success when a
  process merely exists.
- Shut down in dependency-aware order and leave unrelated resources untouched.

An agent or developer should be able to ask which component is unhealthy, see
the relevant sanitized output, and understand the next corrective action.

## Development and production parity

“Works locally” should provide meaningful evidence about deployment, but parity
must not be overstated.

Dads should preserve these across environments wherever practical:

- Source and dependency lockfiles.
- Build recipe and produced application artifact.
- Runtime entrypoint and configuration parser.
- Database and authorization migrations.
- Health and readiness definitions.
- Declared capability bindings for the target environment.

Development-only source mounts, file watchers, local routing, fake integrations,
and seed data remain explicit differences. Production orchestration, networking,
secret distribution, scaling, and persistence may also differ. The environment
contract should expose those differences instead of pretending Docker Compose
and production are identical.

A high-value future workflow is build once, identify the resulting image by
content digest, and promote that same artifact through integration and
production environments.

## Parallel task environments

The development environment should integrate with Dads's agent operating
model:

- Each task receives a unique environment identity.
- Mutable databases, queues, volumes, ports, and routes are isolated when their
  state could affect correctness.
- Immutable images, package caches, and read-only service layers may be shared
  when doing so cannot mix task state.
- The tool records which task owns each managed resource.
- Stale task environments are discoverable and removable by exact ownership.
- Shutting down one task cannot stop another task's services.

This avoids solving source collisions with worktrees while leaving every agent
fighting over the same database, port, watcher, or container project.

Linked git worktrees carry one trap the tooling has to hold. Git exports an
absolute `GIT_DIR` to any hook it runs from a linked worktree, and every child
process inherits it. Anything that spawns `git` for a different root, the
toolbox's scope reader and snapshot identity included, strips every `GIT_*`
variable from the environment it hands to `git`. A script or test that forgets
this operates on the hook's repository instead of the directory it was given;
on 2026-09-05 that committed three test fixtures onto a real branch during a
pre-push hook. The rule: never let a spawned `git` inherit `GIT_*`.

See [agent-operating-model.md](./agent-operating-model.md).

## Optional by design

Dads's application, authorization, operation, and capability packages must
remain usable without this toolbox. A team may use an existing devcontainer,
Docker Compose project, Kubernetes development tool, Nix environment, or custom
platform.

The portable boundary is the declared application and environment contract. The
Dads development environment is the maintained default implementation and
the easiest supported path, not a runtime dependency imposed on every consumer.

## Initial proof

The first reference application should prove that:

- A machine with the documented minimum prerequisites reaches readiness through
  one command.
- A second developer can repeat the setup without private assistance.
- Missing dependencies, port conflicts, failed migrations, and unhealthy
  services produce actionable diagnostics.
- The application image and migration entrypoints used in integration are the
  ones intended for deployment.
- Two task environments can run concurrently without sharing mutable source,
  data, ports, or owned lifecycle.
- Shutdown and reset affect only resources the selected project or task owns.
- The application remains runnable through ordinary package commands when the
  optional environment toolbox is not used.

## Non-goals

The initial capability does not attempt to:

- Install every possible machine-wide prerequisite without user involvement.
- Hide Docker, networking, migration, or deployment failures behind endless
  retries.
- Guarantee production parity when the target platform has materially different
  infrastructure.
- Turn every library or capability into a separate service or container.
- Replace a production orchestrator, infrastructure-as-code system, or secrets
  manager.
- Require Nx or Docker to use Dads's framework packages.
- Manage unrelated repositories or containers it did not create.

## Recommended build order

1. Define the minimum environment contract required by the reference
   application.
2. Implement `dev:up`, readiness, status, logs, and exact owned shutdown for that
   one application.
3. Build its API and worker components through the same image recipes intended
   for integration and deployment.
4. Add `dev:doctor` from failures observed during real second-machine setup.
5. Prove two isolated task environments before adding generalized agent
   coordination.
6. Add alternative environment providers only after a real team cannot use the
   maintained default.
