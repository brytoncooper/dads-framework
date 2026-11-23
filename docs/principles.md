# Dads guiding principles

This is the design reference for choosing where a change belongs. For the
rules you can run in an application today, see [domain boundaries](domain-boundaries.md)
and the [Doctor command reference](doctor.md).

Dads is a TypeScript application framework for building systems around
stable, application-owned capabilities. It keeps foreign dependencies outside
application code, allows several dependencies to become one coherent local
capability, and makes behavioral accuracy reusable across production and test
implementations.

## The Independent Evolution Principle

> **Things that can evolve independently should be owned, represented, and
> contracted independently.**

Applied to architecture: **align the shape of the dependency graph with the
shape of change.**

### The core idea

Things should only be coupled when they genuinely need to change together.

If two parts of the system can evolve independently, put a boundary between them
— and give each side the contract it actually needs, instead of sharing internal
representations just because they happen to look the same today. Two things
looking identical right now doesn't mean they have the same owner, the same
lifecycle, or the same reasons to change. **Similarity is not ownership.**

A boundary earns its existence by absorbing change. If changing persistence
forces API changes, changing the API forces UI changes, or changing one feature
drags unrelated features along with it, the boundary isn't doing its job.

Every abstraction, layer, adapter, mapper, or SDK should answer one question:
**what change does this absorb, and is that change real?** Name it (a second
implementation that exists, an independently deployed client, another domain's
release, a vendor swap). If you cannot name one, it is indirection without
independence — remove it.

### Meaningful boundaries vs. not boundaries

**Meaningful boundaries** — a contract is required, and provider internals stay
walled behind it:

- **Wire (API ↔ every client):** web, mobile, SDKs, and external integrations.
  Contract schemas are hand-written and owned by the wire boundary, never
  derived from database tables.
- **Domain ↔ domain:** a consumer-owned port (a narrow `type`, bound in the
  composition root) or a domain event — never an internal import.
- **Application ↔ framework / kit** (and package ↔ package): public exports
  only.
- **Persistence ↔ wire:** a database row never becomes a DTO.
- **Application code ↔ swappable vendor:** one chokepoint (Authorization,
  clock, queue, object storage, email, identity).

**Not boundaries** — one owner, change together, so no port, no extra file, and
no extra package:

- A route, its handler, and its access declaration.
- Row/insert types and their table definition (derive from the table schema).
- A feature page and its data loader.
- An SDK facade and its only implementation.

Inside one owner, prefer direct imports and concrete types. **One test seam is
kept on purpose:** an operation may reach its own domain's store through a
bare-name reader/writer contract so unit tests can swap in an in-memory fake
that stores and returns rows — a test seam, not an architectural boundary; it
never re-implements a database constraint or lock, and nothing else inside one
owner gets a fake.

### Precedence

The Independent Evolution Principle outranks more specific _structural_ rules —
layout conventions, generator defaults, and file-splitting habits. When a
structural rule demands a seam that fails the companion test, follow IEP, name
the rule you set aside, and flag the doc or generator.

IEP **never** overrides safety walls or meaningful boundaries: strict TypeScript
and lint gates, cross-domain import isolation, deep-import bans, mandatory
`Authorization`, or keeping ORM/table imports out of pure domain logic. It is
never a licence to merge across a meaningful boundary merely because two shapes
look alike today.

### What this doesn't mean

Independence doesn't mean duplicating everything. Shared contracts, schemas, and
types are appropriate when things genuinely share ownership and are expected to
evolve together. The goal isn't maximum separation — it's making coupling
_intentional_ and proportional to the actual relationship between components.

That said: a shared abstraction that forces independently changing systems to
move together is usually more expensive than a small amount of duplication.

In practice:

- Prefer narrow contracts over shared representations.
- Prefer explicit adapters over leaked implementation details.
- Prefer stable domain vocabulary over framework-, storage-, transport-, or
  UI-specific shapes.
- Point dependencies toward whatever _owns the meaning_, not toward whichever
  representation already happens to exist.

The desired result: **changes stop as close as possible to the place that owns
them.**

### Why it's worth it

- **Smaller blast radius.** A change in one place is far less likely to force
  unrelated changes elsewhere.
- **Faster CI, cleaner affected graphs.** The dependency graph reflects what
  actually depends on what.
- **Multiple clients get easier.** Web, mobile, SDKs, and future clients evolve
  around their own needs instead of inheriting another client's (or the
  server's) accidental assumptions.
- **Safer refactoring.** Persistence, frameworks, and transport details can
  change without every consumer knowing.
- **Clearer ownership.** Looking at any type or contract, it should be obvious
  who owns it and what changes are allowed to reach it.
- **Safer for AI agents and new developers.** Real, enforced boundaries shrink
  the area anyone needs to understand to make a given change.
- **Less architectural drift.** One consistent rule for where things belong,
  instead of every feature inventing its own dependency relationships.

### The tests

Use these when reviewing a design, a PR, or an existing boundary:

| Test            | Question                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| **Change**      | What kinds of changes should stop at this boundary?                                                        |
| **Ownership**   | Who owns the meaning of this representation?                                                               |
| **Evolution**   | Could these two sides reasonably change at different times, for different reasons?                         |
| **Leak**        | Is the consumer depending on what the provider _means to expose_, or on how it happens to be implemented?  |
| **Abstraction** | What change does this layer absorb? If none, remove it.                                                    |
| **Coupling**    | If this changes, what else becomes dirty? Are those dependencies actually necessary?                       |
| **Sharing**     | Are we sharing this because the concepts truly evolve together — or just because they look the same today? |

## Core promise

**Stable boundaries. Replaceable systems.**

A major dependency or an entire implementation domain should be replaceable at
one declared perimeter. The replacement may still be substantial inside that
perimeter, but the rest of the application should not need to understand it.

Dads promises a contained and predictable blast radius. It does not pretend
that persisted data, public contracts, authorization models, or operational
migrations disappear.

## Vocabulary

- **Application code** expresses domain policy, use cases, and product behavior.
- **Capability** is an application-owned contract named for a responsibility the
  application needs, such as document storage or identity verification.
- **Implementation** fulfills a capability using local code, one dependency, or
  several coordinated dependencies.
- **Foreign dependency** is a third-party package, service, SDK, driver,
  framework, or externally owned data model.
- **Composition root** is the one edge where concrete implementations are chosen
  and connected to the capabilities the application consumes.
- **Operating model** is the framework-owned explanation of how humans and agents
  change, test, verify, and safely coordinate work in a Dads project.
- **Development environment contract** declares the services, toolchains,
  lifecycle, routes, health checks, and build artifacts required to run an
  application consistently.
- **Adoption unit** is a public Dads package or tool that delivers useful,
  documented behavior without requiring adoption of the complete framework.

## 1. The application owns its language

Application code speaks only in application-owned capabilities, values, and
errors. It does not organize itself around vendor APIs.

- Name a capability for the responsibility it provides, not the vendor currently
  providing it.
- Define the smallest contract the consumer actually needs.
- Let foreign code implement an application capability; never let it define one.

`DocumentStorage` is a capability. `S3Wrapper` is an implementation detail.

## 2. Foreign dependencies are quarantined

Third-party imports belong only in declared integration or edge packages.
Application and domain packages must be unable to import them.

The quarantine includes more than imports:

- Foreign types do not cross a capability's public boundary.
- Foreign errors are translated into application-owned errors.
- Foreign configuration, lifecycle, and client construction stay inside the
  implementation.
- External data is parsed and mapped once at the boundary.

A deliberately small foundational allowlist may exist, but every exception must
be explicit, centrally visible, and mechanically enforced.

## 3. Many dependencies may become one capability

A capability is not required to be a thin wrapper over one package. One local
implementation may coordinate several related dependencies and expose a single
application-shaped contract.

The implementation owns their interaction, configuration, lifecycle, failure
mapping, observability, security policy, workarounds, and upgrade churn. The
application sees one coherent capability; the number and identity of the parts
behind it are private.

**Many dependencies in. One owned capability out.**

## 4. Concrete choices happen only at composition

The composition root selects implementations and binds them to capabilities.
Application code does not construct vendor clients, select drivers, inspect the
deployment environment to choose an adapter, or branch on vendor identity.

The same application core should be composable with cloud, local, alternate,
and in-memory implementations without changing its source.

## 5. Domains remain independently replaceable

A domain does not reach into another domain's internals. When it needs behavior
owned elsewhere, the consuming domain declares the minimum capability it needs,
and composition connects a provider.

This keeps dependency direction aligned with application needs rather than the
current deployment graph. Replacing a provider should not require its consumers
to adopt the replacement's vocabulary.

## 6. Tests and production share one contract

Every meaningful capability has executable behavioral expectations. Production,
alternate, and in-memory implementations must pass the same reusable conformance
suite.

An in-memory implementation is not a convenient mock that returns whatever a
test asks for. It is another implementation of the capability and must preserve
the behavior the application relies on: validation, ordering, idempotency,
conflicts, absence, and failure semantics where applicable.

This creates two complementary properties:

- Isolation makes most application tests fast and deterministic.
- Shared conformance makes those isolated tests accurate representations of the
  production contract.

Production code and test code therefore speak the same application-owned
language.

## 7. Verification follows the boundary

Dads favors the lowest test tier that can prove each fact:

1. Pure behavior tests prove domain decisions and transformations.
2. Capability conformance suites prove every implementation behaves alike.
3. Integration tests prove real foreign dependencies satisfy the owned contract.
4. Composition tests prove the intended implementations are wired together.
5. Focused end-to-end tests prove only the critical assembled journeys.

No tier replaces the others. In particular, an in-memory implementation cannot
prove a vendor integration, and an end-to-end test should not be the first place
application policy is exercised.

## 8. Rules are enforced by construction

An architectural rule is unfinished until ordinary tools can detect its
violation. Dads should deny boundary leaks by default through import rules,
package ownership, public-type checks, dependency manifests, and composition
constraints.

At minimum, a compliant application must be able to prove that:

- Application and domain packages do not import foreign dependencies.
- Public capability surfaces contain no foreign types.
- Only composition roots select concrete implementations.
- Every registered implementation runs the capability's conformance suite.
- Domain-to-domain needs cross consumer-owned contracts, not internal imports.
- Dynamic loading cannot silently bypass the dependency wall.

The easiest path through the framework should be the correct path.

## 9. Replacement cost is local, not imaginary

Dads does not promise that replacing a database, identity provider, message
broker, UI framework, or complete implementation domain is effortless. It
promises that the cost is concentrated behind a known boundary and that the
behavior to preserve is executable.

A good boundary turns a global rewrite into a local replacement plus explicit
migration work.

## 10. Abstractions must be earned

Dads does not wrap every library merely because it is external. A capability
exists when the application has a responsibility to own, a policy to protect, or
a meaningful reason to isolate change.

It must not become:

- A collection of vendor-shaped interfaces with local names.
- A universal lowest-common-denominator API.
- A maze of indirection without a real replacement or testing boundary.
- An excuse to hide necessary integration and migration tests.

## 11. The framework teaches its own operating model

A Dads project should explain not only what architecture is permitted, but
also how responsible work is performed inside it.

The same framework-owned sources should drive human documentation, agent
instructions, task playbooks, generators, test recommendations, and enforcement
diagnostics. Agent-specific files may adapt the presentation for Codex, Claude,
Cursor, or another harness, but they must not fork the underlying rules.

The operating model should teach a contributor to:

- Inspect the project and identify the owner and boundary before editing.
- Choose the smallest independently verifiable task.
- Work in an isolated checkout or task workspace when changes run in parallel.
- Run the lowest test tier that proves the behavior, followed by the required
  integration and completion gates.
- Preserve other work, detect overlapping ownership, and integrate deliberately.
- Report what is proven separately from what has not been run or deployed.

Skills and agent guidance are therefore part of Dads's developer
experience, but not its architectural source of truth. A framework rule must
remain enforceable for a human or an agent that never loaded a skill.

See [agent-operating-model.md](./agent-operating-model.md).

## 12. Reproducibility includes the development environment

Application architecture is incomplete when it is easy to understand but hard
to start, diagnose, or deploy consistently.

Dads should be able to describe an application's development environment as
an explicit contract and optionally operate that contract for the team. The
contract should cover required services, dependency versions, routing, health,
startup and shutdown order, migrations, watchers, configuration schemas, and
the build artifacts intended for deployment.

The default toolbox should prefer project-scoped or containerized dependencies
over undocumented host state. It may download declared project dependencies and
images, but it must not silently install privileged machine-wide software,
rewrite unrelated host configuration, or hide destructive resets.

Development and production do not need identical orchestrators. They do need an
intentional relationship: the same application source, build recipe, runtime
entrypoint, configuration contract, and migration behavior should be exercised
as far as the target environments allow. Environment-specific differences must
be declared instead of discovered after deployment.

This capability remains optional. A team may use its own environment tools,
but doing so must not require changes to the application's owned capabilities or
domain code.

See [development-environment.md](./development-environment.md).

## 13. Every public capability is independently adoptable

Dads is a coherent ecosystem that may be assembled and deployed as a
monolith. It must not become an indivisible package or an architecture in which
all capabilities share one ownership and dependency boundary.

Each public package should earn adoption on its own. A team may use the HTTP
route model without the domain profile, use authorization without the
development environment, or use conformance testing without adopting
Dads's agent operating model.

Independent adoption requires more than publishing several names from one
coupled implementation:

- A package exposes a complete public surface for the responsibility it owns.
- Its runtime dependency graph contains only what that responsibility actually
  needs.
- It does not rely on Dads repository aliases, private source paths, Nx
  metadata, global initialization, or an undisclosed composition root.
- Its configuration, documentation, tests, diagnostics, and lifecycle work in a
  plain TypeScript application.
- Rules specific to that package activate when it is adopted; unrelated profile
  rules do not.
- Optional integration with another Dads capability occurs through an
  explicit bridge or stable shared contract rather than a hidden import.

Small foundational packages may be shared when they genuinely own common
meaning. Independent adoption does not mean duplicating every primitive or
having zero transitive dependencies. It means adopting one capability never
silently commits the application to the rest of Dads.

The full framework and its stricter profiles must compose the same packages and
public APIs offered to incremental adopters. There must not be an internal
"real Dads" path unavailable to standalone users.

A full-profile application may deliberately compile those packages into one
modular monolith, run them in one process, and ship them in one image. Deployment
unity does not require source, contract, test, or ownership unity.

Profiles form increasing enforcement contracts. A higher profile may require a
specific Dads capability, such as Dads authorization for every
protected HTTP operation, and activate the compiler, policy, conformance, and
completion gates that make the requirement real. Selecting a stricter profile
must never amount to copying stronger recommendations into documentation while
leaving violations possible.

See [adoption-model.md](./adoption-model.md).

## The decision test

When evaluating a design, ask:

> Could the application keep expressing the same behavior if every concrete part
> behind this boundary changed?

If the answer is no because application code knows a vendor type, imports a
provider, coordinates several dependencies itself, or tests against behavior no
production implementation proves, the boundary is leaking.
