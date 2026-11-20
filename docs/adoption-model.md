# Dads adoption model

Status: product direction. This document defines how Dads remains a
coherent framework while allowing teams to adopt and trust it one capability at
a time.

## The promise

Every public Dads capability should provide useful standalone value.

A team should be able to begin with the part that solves an immediate problem:

- The HTTP route and operation model.
- Relationship-based authorization.
- Capability conformance testing.
- Architecture policy checks.
- A reproducible development environment.
- Agent guidance and isolated task workflows.
- An Nx workspace integration.

Adopting one must not require accepting all the others. When the team later adds
another Dads capability, the two should compose through documented public
surfaces without forcing a rewrite of the first adoption.

This creates a trust gradient: useful library, compatible ecosystem, stronger
profile, and eventually a complete framework experience if the application
wants it.

## Ecosystem and deployment shape

Independent adoption does not require a microservice architecture or a process
per package.

Dads is a coherent ecosystem of packages, tools, profiles, and integration
contracts. An application may select the complete ecosystem and assemble it as a
modular monolith:

- One application composition root.
- One process when that deployment shape is appropriate.
- One Docker/OCI image.
- One coordinated release of the application.

The package boundaries still identify ownership, permitted dependencies,
replaceable implementations, focused tests, and change blast radius inside that
monolith. Runtime unity and deployment unity do not erase architectural
boundaries.

Dads should support both ends honestly: one independently useful package
in an existing application, or a deeply integrated modular monolith governed by
a strict profile.

## Adoption units

An adoption unit is a published package, CLI, or optional tool with one
recognizable responsibility.

Every adoption unit must have:

- A package manifest and explicit runtime, peer, and development dependencies.
- A public API that never requires private source imports.
- A standalone quick start that assumes no other Dads package unless that
  dependency is part of the capability's stated contract.
- Focused documentation for configuration, lifecycle, failures, and testing.
- A plain TypeScript consumer fixture outside the full reference application.
- Focused unit and integration proof for the behavior it owns.
- A compatibility statement for any optional Dads integrations.
- A release and deprecation path that does not rely on unpublished monorepo
  state.

An adoption unit may depend on a small foundational Dads package when that
package owns meaning genuinely shared by both. It may not depend on an umbrella
package merely because the packages live in one repository.

## Standalone first, composition second

The standalone path is a design constraint, not an alternate implementation.

For example, the HTTP package should be capable of defining and serving typed
routes in an ordinary TypeScript application. It may require every route to
declare an explicit access posture, including public access, without requiring a
specific authorization engine.

A separate HTTP–authorization integration can translate richer Dads
authorization declarations into the HTTP package's generic access decision
surface. The HTTP package must not import SpiceDB, a Postgres authorization
outbox, the domain profile, or the development environment to make that
integration possible.

The same pattern applies elsewhere:

```text
independently useful capability A
              │
              ▼
      small public integration
              ▲
              │
independently useful capability B
```

The integration may be owned by one side when the dependency direction is
unambiguous, or by a small bridge package when neither capability should own the
other. It must not become a generic integrations drawer.

## Progressive adoption

Use the [creator](site/guides/quickstart.md) to see public packages assembled
into a working app. For an existing app, the [adoption guide](site/guides/adopt.md)
shows how to create an isolated starter under the host's `dads/` directory.
Moving a route from the host is a separate change. Capture its current
response and denial behavior in tests before changing which code serves it.

One possible adoption path is:

1. Install the HTTP package for typed routes and explicit edge behavior.
2. Add Dads authorization and its HTTP integration when the application
   needs relationship-based permissions.
3. Add conformance testing for application-owned external capabilities.
4. Add the portable policy checker to make dependency and public-type boundaries
   mechanical.
5. Adopt the domain profile when the application's independent business areas
   justify those stronger walls.
6. Adopt the development environment and agent operating model when the team
   wants standardized setup and collision-safe parallel work.

This is an example, not a required maturity ladder. A team may adopt policy
checking first, use the development environment with a non-Dads HTTP stack,
or stop after one package indefinitely.

## Profiles compose packages and enforce stronger contracts

A Dads profile is a binding selection of packages, defaults, policy rules,
required proofs, and composition constraints. It should make a coherent setup
easier, but it must not contain a hidden framework implementation.

The flexible profile may select typed operations, explicit access posture,
conformance support, and basic foreign-dependency quarantine. A domain profile
may add domain ownership, consumer-owned cross-domain ports, and public-surface
rules. A strict profile may add no cross-domain imports or foreign keys,
invariant declarations, test placement, and stronger completion gates.

Applications using the same packages manually and applications using a profile
must exercise the same runtime code and public contracts.

Profiles increase enforcement rather than merely adding suggestions:

| HTTP adoption                  | Authorization contract                                                                                        | Enforcement                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Standalone HTTP**            | Explicit public, session, or application-provided access decision                                             | HTTP type and runtime guarantees only; no Dads authorization package required                                                      |
| **Dads-secured HTTP**          | Protected operations must use the Dads authorization contract; the backing implementation remains replaceable | Missing access and direct authorization bypasses fail; supported single-resource and list authorization paths are required         |
| **Strict application profile** | Dads relationship-based authorization is mandatory for protected resources                                    | Adds ownership-write proof, denial tests, authorized-list enforcement, domain boundaries, composition checks, and completion gates |

The stricter choices are not separate forks of the HTTP library. They compose
the same HTTP package with authorization and policy packages, then make the
selected relationship mechanically mandatory.

Once an application selects a profile, violating that profile should fail at
the earliest credible point:

1. Type errors for structurally incomplete declarations.
2. Fast policy diagnostics for forbidden imports and bypasses.
3. Conformance and integration failures for incorrect implementations.
4. Composition failures for missing required bindings.
5. Completion or CI failures when required proof has not run or passed.

Moving to a higher profile is therefore a deliberate increase in guarantees.
Moving to a lower profile is an explicit architecture decision, not a local
suppression added to make one violation pass.

## Policy activation follows adoption

Dads policy must know which packages and profiles an application has chosen.

- Universal TypeScript correctness checks may apply wherever the policy checker
  is installed.
- HTTP-specific checks apply to Dads HTTP declarations.
- Authorization ownership and denial checks apply when Dads authorization
  is adopted.
- A profile may make an otherwise optional package mandatory and activate rules
  proving that all applicable code uses it.
- Domain isolation and cross-domain foreign-key rules apply only when the domain
  profile is selected.
- Agent and development-environment rules apply only to resources those tools
  own.

A partial adopter should receive protection for the capability it selected, not
a wall of failures demanding unrelated architectural changes.

## Dependency discipline

Independent adoption should be verified from published artifacts, not inferred
from source folders.

For each adoption unit, automated checks should prove:

- The packed package contains only its intended public and runtime files.
- Installation in a clean plain TypeScript fixture succeeds.
- Its dependency tree does not pull unrelated Dads capabilities or foreign
  vendors.
- Its quick-start example typechecks, runs, and performs its documented behavior.
- Removing optional Dads integrations leaves the standalone path working.
- No test succeeds only because of monorepo path aliases, hoisted undeclared
  dependencies, or Nx project inference.

Nx, Docker, and agent-harness fixtures may provide additional integration proof.
They cannot replace the plain consumer fixture.

## Versioning and compatibility

Packages should be able to evolve independently when their ownership and reasons
to change are independent. A repository-wide change does not automatically mean
every public package needs a release.

Bridge packages and profiles should declare the compatible public versions they
compose. Compatibility tests should install those declared combinations in
consumer fixtures. When coordinated change is genuinely required, the release
notes should state which packages must move together and why.

Independent versioning is not a goal by itself. The goal is to prevent an
unrelated package release or migration from becoming the price of adopting one
small capability.

## Documentation for each package

Every public package should answer three questions without sending the reader to
the full framework guide:

1. How do I use this package by itself?
2. Which application responsibility and changes does it absorb?
3. How does it compose with related Dads packages if I choose them later?

The full Dads documentation may provide a guided path across packages, but
standalone documentation must remain complete enough to succeed.

## Initial proof

The [adoption harness](../scripts/adoption/verify-adoption.mjs) runs packed
consumer checks. The three scenarios below describe the evidence expected
from a standalone capability, a secured capability, and a full composition:

1. A plain TypeScript application using only the initial HTTP package and its
   true foundational dependencies.
2. A secured application using the same HTTP declarations under the profile that
   requires Dads authorization.
3. The reference application composing HTTP, authorization, conformance testing,
   policy enforcement, and its selected profile.

The proof should demonstrate that:

- The standalone fixture does not install authorization vendors, Nx, agent
  toolbox, or the development environment.
- The same HTTP route declarations work when richer authorization is added
  through the public integration surface.
- The secured fixture fails when a protected route bypasses Dads
  authorization, omits its access declaration, or lacks its required proof.
- Package-specific diagnostics remain useful in both contexts.
- The full reference application imports the same published entrypoints as the
  standalone fixture.
- No framework-only private path exists.

## Non-goals

Independent adoption does not mean Dads must:

- Publish every internal helper as a supported package.
- Remove every small shared primitive or duplicate it into every capability.
- Keep integrations compatible with every historical package version forever.
- Offer every feature without any transitive dependency.
- Pretend two capabilities are independent when their semantics genuinely
  require coordinated change.
- Build a package marketplace before the first packages prove standalone value.

## Recommended build order

1. Choose the smallest public package required by the reference slice, likely
   the transport-neutral operation and HTTP route surface.
2. Define its standalone public contract and actual minimal dependency tree.
3. Build and pack it as a real package rather than consuming source aliases.
4. Prove it in a clean plain TypeScript fixture.
5. Add the next Dads capability through an explicit public integration.
6. Prove the reference application uses exactly those same packages and paths.
7. Introduce a profile only after the standalone and composed paths are both
   real.
