# Dads goals

Status: current product direction. These goals define what Dads must make
true before larger product ideas deserve attention. The architectural reasoning
behind them lives in [principles.md](./principles.md).

## Current objective

Build a genuinely pleasant TypeScript backend framework for safe, strongly
typed APIs with clear, firm architectural boundaries.

Dads should help a developer or coding agent understand where behavior
belongs, express it in application-owned language, secure it without inventing
an authorization pattern, and prove it without reconstructing the entire system
in their head.

The immediate goal is a working, useful framework with a real application built
against it. Future products must build on that proof; they must not distract from
creating it.

The specifically sequenced work after the first installable release is recorded
in the maintainer's private product roadmap.

Dads should also make the application straightforward to operate while it
is being built. Its optional development toolbox should teach humans and coding
agents how the framework is meant to be used, provide safe paths for parallel
work, and make a reproducible local environment available without each team
inventing its own setup scripts.

## Primary users

Dads is initially for:

- TypeScript developers building or extending serious applications.
- Teams that want strong architectural boundaries without relying on every
  contributor to remember unwritten rules.
- Coding agents and low-context developers who need the repository itself to
  explain ownership, placement, and permitted dependencies.

The first users are Dads's own maintainers. The framework must be good
enough to build its reference application without hidden knowledge or special
exceptions.

## The job to be done

When adding a capability or changing an existing one, a developer should be able
to answer quickly:

- Where does this behavior belong?
- Who owns its types and vocabulary?
- What may it depend on?
- How is access granted, denied, and listed?
- Which behavior can be tested without infrastructure?
- Which real integration still needs proof?
- What else should become affected by this change?

Dads succeeds when these answers come from structure, types, and automated
feedback—not tribal knowledge.

## Product goals

### 1. Produce something tangible before building a platform

Dads must first exist as a framework that can build and run a real vertical
slice. Doctrine alone is not the product.

- Every framework capability must have a real consumer.
- Every abstraction must name the change it absorbs.
- The reference application must use the same public surfaces another
  application would use.
- Dads must not depend on the source code, private conventions, or runtime
  environment of the application Dads was extracted from in order to work.
- That origin application may provide lessons and exemplars, but Dads must
  prove those ideas independently.

### 2. Make safe behavior the default behavior

Safety should come from the shape of the system, not from a reviewer noticing
every mistake.

- Unsafe dependency directions fail automatically.
- Missing or ambiguous access decisions fail closed.
- External values are validated before application code receives them.
- Public contracts cannot accidentally expose foreign types.
- Concrete dependencies can be selected only at declared composition roots.
- Failure messages identify the violated rule and the expected correction.

A rule that exists only in prose is not finished.

### 3. Make the architecture obvious

A low-context human should be able to navigate the framework and an application
built with it from the folder tree and names alone.

- A capability has one obvious owner and one obvious home.
- Paths distinguish domain behavior, contracts, pure logic, integrations,
  transport edges, and composition.
- Related things that evolve together are adjacent.
- Things with different owners or reasons to change are separated by explicit
  contracts.
- Shared folders and generic abstractions cannot become ownership-free dumping
  grounds.

Clarity is part of safety: developers cannot respect a boundary they cannot
find or understand.

### 4. Make permissions easy to implement and difficult to omit

Authorization is a first-class framework capability, not feature-specific glue.

- A protected resource has one obvious place to declare its relationships and
  permissions.
- Application code asks typed, application-owned authorization questions without
  depending on an authorization vendor.
- Both single-resource checks and authorized list discovery have supported,
  recognizable paths.
- Resource creation makes required ownership relationships explicit.
- Denial is the default when no relationship or permission grants access.
- Standard test support makes allowed, denied, ownership, and list behavior easy
  to prove.
- Changing the authorization implementation does not change domain policy or its
  consumers.

The framework should make the secure path shorter and clearer than an ad hoc
permission check.

### 5. Preserve strong types from the edge to the domain

Types must carry meaning across the entire application without escape hatches.

- Boundary schemas own the types derived from external input and output.
- Capability contracts use application-owned types.
- Resource types, relationships, permissions, operations, results, and expected
  errors remain typed.
- Normal framework usage does not require `any`, unsafe assertions, or non-null
  assertions.
- Foreign SDK and persistence types stop at their integration boundaries.
- Generated artifacts, if used, are inspectable and checked for drift.

The compiler should expose an incomplete integration before runtime does.

### 6. Support independent evolution through owned capabilities

Application code depends on the behavior it needs, not on whichever dependency
currently provides it.

- One application-owned capability may be implemented by one dependency,
  several coordinated dependencies, local code, or an in-memory implementation.
- Foreign dependencies remain quarantined inside their implementations.
- Consumers do not change when an implementation is replaced behind a stable
  capability.
- Cross-domain needs use consumer-owned contracts or owned events rather than
  another domain's internals.
- The dependency graph reflects the expected shape of change.

### 7. Make isolated tests accurate

Fast tests and trustworthy tests should reinforce each other.

- Domain behavior is testable as plain TypeScript without framework or
  infrastructure bootstrapping.
- Every meaningful capability defines reusable behavioral expectations.
- Production, alternate, and in-memory implementations run the same conformance
  suite.
- Real integration tests prove the foreign systems actually satisfy the owned
  contract.
- Composition tests prove the intended implementations are connected.
- Focused end-to-end tests remain reserved for assembled journeys that cannot be
  proven at a lower tier.

An in-memory implementation is useful only when production implementations prove
the same semantics.

### 8. Make the framework pleasant to use

"Nice to use" must be observable:

- Common work follows one documented path with few arbitrary decisions.
- Names and folders make the next edit easy to locate.
- Types and editor feedback guide the developer while they work.
- Focused checks return quickly enough to stay in the editing loop.
- Errors explain what is wrong and how to repair it.
- Examples demonstrate real behavior instead of toy syntax.
- The framework uses explicit composition and visible control flow rather than
  surprising registration magic.

The easiest successful path should also be the path that produces maintainable
code.

### 9. Teach humans and agents how to work in the framework

Dads should carry its operating model with it instead of expecting every
team, developer, or agent harness to rediscover one.

- Framework-owned guidance explains where changes belong, how capabilities are
  composed, how authorization is declared, and how boundaries are verified.
- Task-specific playbooks teach agents and developers how to add a capability,
  change a contract, implement an integration, select the right tests, and
  verify completion.
- Test guidance is derived from the affected boundary and explains which pure,
  conformance, integration, composition, and end-to-end proofs are required.
- Agent-facing instructions are generated or adapted from the same policy and
  workflow sources humans use; separate agent harnesses must not become
  conflicting sources of architectural truth.
- Parallel work receives first-class support through isolated workspaces,
  explicit task ownership, overlap detection, and guarded integration.
- Skills are an adoption and teaching surface for the framework, not a second
  implementation of the framework and not an indiscriminate copy of every
  existing skill in the origin application.

The desired result is that a capable but low-context agent can enter an
Dads project, discover the correct workflow, make a bounded change, run the
right proof, and avoid overwriting another task's work.

The complete direction is recorded in
[agent-operating-model.md](./agent-operating-model.md).

### 10. Make development environments reproducible and optional

Dads should offer a first-class development environment that teams may use
instead of maintaining bespoke setup, routing, watcher, and service scripts.

- A command such as `dad dev:up` prepares project-scoped dependencies,
  acquires declared container images, starts services, applies safe setup and
  migrations, configures local routing, starts watchers, and waits for declared
  readiness.
- The environment contract declares required services, versions, ports, routes,
  health checks, persistent volumes, startup order, and development commands.
- Companion commands expose status, logs, diagnostics, shutdown, and explicitly
  guarded reset behavior.
- The same application build definitions and runtime contracts are exercised in
  development, CI, and production wherever practical, so local success is
  meaningful evidence about the artifact that will be deployed.
- Deployable components may provide consistent Docker/OCI images without making
  every framework library a separate container or forcing Docker on applications
  that do not need it.
- Project dependencies may be installed automatically; machine-wide software or
  privileged host changes require an explicit, visible setup step rather than a
  silent mutation.
- Teams may replace this toolbox with their own environment system without
  changing application or domain code.

The complete direction is recorded in
[development-environment.md](./development-environment.md).

### 11. Earn adoption one independently useful package at a time

Dads must be adoptable as a collection of coherent capabilities, not only
as an all-or-nothing framework commitment.

- A team that wants Dads's HTTP route model can install and use it without
  adopting Dads authorization, domains, policy profiles, agent toolbox,
  development environments, or Nx integration.
- The same HTTP system may be adopted through a stronger profile that requires
  Dads's authorization model and mechanically rejects routes or operations
  that bypass it.
- Authorization, conformance testing, architecture policy, development toolbox,
  and workspace integrations each provide useful public surfaces of their own.
- When two capabilities work together, their integration is explicit and small;
  one package must not secretly pull the rest of the framework into the
  application.
- Each independently adoptable package has its own quick start, public API,
  dependency declaration, focused tests, compatibility statement, and plain
  TypeScript consumer fixture.
- Package-specific policy activates only for capabilities the application has
  adopted. Dads must not punish a partial adopter for omitting an unrelated
  Dads convention.
- The complete Dads experience is composed from the same public packages
  available to partial adopters; it is not a separate privileged implementation.
- Adding another Dads capability should preserve the application code
  already written against the first one.
- A profile is a binding enforcement contract, not a documentation preset. When
  an application selects a higher profile, its additional compiler, policy,
  test, composition, and completion requirements fail automatically when
  violated.
- The ecosystem may be assembled into one modular monolith, process, and
  deployable image without erasing the package boundaries that make incremental
  adoption and independent evolution possible.

Incremental adoption lowers trust cost. A team may begin with one library,
experience its clarity and safety, add compatible pieces as needs appear, and
eventually adopt a stronger profile without performing a framework rewrite.

The complete direction is recorded in
[adoption-model.md](./adoption-model.md).

## First tangible milestone

The first milestone is one small but complete reference application slice. It
must be substantial enough to exercise the framework rather than merely display
its syntax.

The slice must include:

- An application-owned resource and vocabulary.
- Boundary schemas with inferred input and output types.
- Pure domain behavior.
- Create, read, and list behavior.
- Relationship-based authorization, including ownership and denial.
- A persistence or external-system capability behind an owned contract.
- A real implementation and an in-memory implementation.
- One composition root that selects the real implementation.
- Reusable conformance tests plus focused integration and composition proof.
- Automated violations demonstrating that forbidden imports, missing access, and
  foreign public types are rejected.
- A short, reproducible guide for adding the next similar capability.
- One optional `dad dev:up` path that brings the reference application to a
  declared ready state from documented minimum host prerequisites.
- Agent guidance that identifies the slice's ownership boundaries, the supported
  change workflow, and the proof required for each kind of change.
- At least one plain TypeScript consumer fixture that uses a public Dads
  package independently of the reference application's full framework profile.

This slice is the surface against which the framework is designed. Framework
machinery should be added only when the slice creates real pressure for it.

## Initial acceptance criteria

Dads's first usable version is successful when:

- A new developer can locate every part of the reference capability from the
  repository tree without private guidance.
- The reference application runs without importing or depending on the origin
  application.
- Application and domain code contain no undeclared foreign dependency imports.
- Types remain application-owned and compiler-checked across the complete
  request-to-domain-to-result path.
- Omitting authorization from a protected operation is rejected automatically.
- Allowed, denied, owned-resource, and authorized-list behavior are proven.
- The real and in-memory implementations pass the same behavioral contract.
- Replacing the real implementation requires no change to its consumers.
- Deliberate boundary violations fail with actionable diagnostics.
- The documented workflow can be repeated to add a second capability without
  inventing a new architecture.
- A new developer or agent can start and diagnose the reference environment
  without private setup guidance.
- Two isolated tasks can work against the project concurrently without sharing a
  mutable checkout or silently overwriting one another.
- A standalone consumer can install the initial HTTP package without acquiring
  authorization vendors, the domain profile, Nx, agent toolbox, or the
  development environment.
- Adding a second compatible Dads package uses a documented integration
  surface and does not require rewriting the first package's consumer code.
- Selecting the strict HTTP and authorization profile makes bypasses, missing
  access declarations, unsupported list authorization, and omitted ownership
  proof fail through automated enforcement.

These criteria prove a usable foundation. They do not prove every future
framework capability or commercial application.

## Not goals right now

Dads is not currently trying to:

- Migrate arbitrary legacy applications.
- Build a universal application intermediate representation.
- Support every database, transport, UI framework, or authorization engine.
- Build the deferred
  [server-side polyglot capability host](./polyglot-capability-host.md) before the
  core framework proves itself.
- Reproduce all of the origin application as a reusable package.
- Require an application to adopt the entire Dads ecosystem before any one
  package provides value.
- Copy every skill from the origin application into Dads or require an AI
  agent to use the framework.
- Require Nx, Docker, or Dads's development environment toolbox to consume
  the runtime framework packages.
- Create a plugin marketplace or generalized platform before concrete use cases
  demand one.
- Optimize for a migration business, pricing model, or recurring-service offering.
- Promise that replacing persisted data or public contracts requires no explicit
  migration work.

## Future horizon: proof-driven migration

A framework that is useful, enforced, independently evolvable, and behaviorally
provable could eventually become the target of a legacy-modernization product.
That is a possible product end goal, not the current milestone.

Migration requirements may be recorded for later, but they must not introduce
unused abstractions or distort the framework's immediate developer experience.
Dads must earn value as a framework even if the migrator is never built.

## Build-order rule

Choose work by asking what the reference slice needs next:

1. Build the smallest application behavior that exposes a real framework need.
2. Add only the framework surface required to support it safely and clearly.
3. Prove the successful path and the forbidden path.
4. Improve the developer experience using observed friction.
5. Prove the extracted package works in one standalone consumer outside the
   reference application's full profile.
6. Add a second capability to test whether the structure repeats and composes
   cleanly.

Do not build a generalized subsystem merely because a future product might need
it.

## Recommended next step

Specify the first reference capability and its complete happy, denied, failure,
integration, and replacement behaviors. Then turn that one slice into a small,
verifiable implementation plan.
