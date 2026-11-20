# Server-side polyglot capability host

Status: deferred design proposal. This is a possible future Dads capability,
not part of the current framework milestone in [goals.md](./goals.md).

## The idea

Allow a server-side Dads application to implement an application-owned
capability using libraries written for another language without exposing that
language, its libraries, or its runtime to TypeScript application code.

The application should consume the same capability whether its implementation
is:

- Native TypeScript.
- An in-memory TypeScript implementation used by tests.
- A managed Python, Rust, Go, Java, C#, or other guest process.
- Several foreign-language libraries coordinated behind one guest adapter.
- A separately deployed service.
- Eventually, a compatible WebAssembly component.

Only the composition root should know which execution model was selected.

## Why someone would want it

The reason is not that multiple languages are inherently desirable. The reason
is that a valuable library should not force the entire application to adopt the
library's language.

Potential use cases include:

- Python machine-learning, scientific-computing, document-processing, OCR, or
  data-analysis libraries.
- Rust or C++ parsing, compression, media, cryptography, or performance-critical
  libraries.
- Java or C# industry SDKs that have no credible TypeScript equivalent.
- Mature company-owned algorithms that would be risky and expensive to rewrite.
- Several specialized foreign libraries that should appear to the application
  as one coherent capability.

Without a common host, teams usually have to rewrite the library, let foreign
types leak through the application, build bespoke process plumbing, or create a
separately operated microservice for each integration.

The host would be valuable only if it makes those boundaries typed, managed,
testable, secure, and repeatable. Merely launching a Python process is not a
framework capability.

## Core promise

> A capability's implementation language can change without changing the
> application that consumes it.

The application owns the capability's meaning. The guest language owns its
implementation. A typed protocol is the only connection between them.

This directly applies the
[Independent Evolution Principle](./principles.md#the-independent-evolution-principle):
the TypeScript application, cross-language protocol, guest adapter, and foreign
library are separately owned representations with separately controlled reasons
to change.

## This is a contract compiler, not a library compiler

The host would not generally compile an arbitrary Python or Rust library into
TypeScript. Instead, Dads would compile a capability contract into the
plumbing required on both sides:

- A typed TypeScript proxy consumed by the application.
- Runtime validation and serialization for requests and responses.
- A generated interface or server stub in the guest language.
- Protocol-version and capability-version metadata.
- Test bindings capable of running the capability's conformance suite.

A small handwritten guest adapter would still map that generated interface onto
the chosen foreign library. Dads should eliminate repetitive transport and
lifecycle work, not pretend that two APIs with different semantics can be mapped
without judgment.

## Conceptual architecture

```text
TypeScript domain or operation
            │
            ▼
Application-owned capability
            │
            ▼
Generated TypeScript host proxy
            │
            ▼
Versioned typed protocol
            │
            ▼
Generated guest-language interface
            │
            ▼
Small guest adapter
            │
            ▼
One or more foreign-language libraries
```

Composition selects the implementation and provides the proxy to the consumer.
No application or domain module imports the guest runtime or library.

## Intended developer experience

A future workflow could look like this:

1. Define or select an application-owned Dads capability.
2. Choose a supported guest language and execution backend.
3. Generate the TypeScript proxy and guest-language interface.
4. Implement the small guest adapter around the desired library or libraries.
5. Declare how the guest is built, started, and restricted.
6. Run the shared capability conformance suite against the guest implementation.
7. Bind the implementation from composition.

A conceptual declaration might contain:

```yaml
capability: document-understanding@1
runtime: python
entrypoint: document_understanding.main
permissions:
  filesystem: none
  network: none
resources:
  memory: bounded
```

This is illustrative, not a committed manifest format.

From application code, a call should remain ordinary and application-shaped:

```ts
const result = await documentUnderstanding.extract(document);
```

The consumer should not know whether the implementation is TypeScript, Python,
Rust, remote, or WebAssembly.

## Server-only initial scope

The initial idea is exclusively server-side.

A server can start processes, package native dependencies, mount controlled
filesystems, provide secrets, restrict environment variables, establish local
connections, monitor health, and restart failed workers. These capabilities make
a general cross-language host feasible.

A web client would use a polyglot capability through the application's normal
server API:

```text
Browser → Dads server → application capability → guest implementation
```

Running arbitrary foreign-language libraries directly in a browser is a separate
idea with different constraints. Browser-local support would primarily depend on
libraries compiled for WebAssembly and must not shape the server host's initial
design.

## Execution backends

### Managed local process: preferred first backend

Dads starts a guest process on the same machine, container, or deployment
unit and communicates through standard input/output, a local socket, or another
typed local protocol.

Advantages:

- Works with existing language ecosystems and native libraries.
- Does not require the library to compile to WebAssembly.
- A crash can be isolated from the TypeScript process.
- The deployment can still behave as one application unit.

Costs:

- Process startup and supervision.
- Serialization and boundary-call overhead.
- Per-language environment and package management.
- Platform-specific native dependencies.

This is the broadest and most practical first experiment.

### Separately deployed service: supported shape, not the first goal

The same capability proxy could eventually address an already deployed service.
That allows independent scaling or an existing service to satisfy the capability,
but introduces network operations, deployment coordination, and distributed
failure modes.

Dads should not require a microservice merely to call a local library.

### WebAssembly Component: promising later backend

A compatible guest could be packaged as a WebAssembly Component with a typed WIT
interface. This could provide portable artifacts, explicit host capabilities, and
stronger runtime isolation.

The limitation is ecosystem coverage. Existing libraries that require a full
language runtime, native extensions, GPU drivers, operating-system behavior, or
unsupported toolchains may not compile into compatible components.

WebAssembly should be an execution option for suitable libraries, not a claim
that every foreign library can be converted.

### Native in-process integration: specialized optimization

Native Node addons or foreign-function interfaces can remove process-call
overhead for C-compatible libraries. They also create the tightest coupling to
ABI, platform, memory-safety, and packaging details.

They should be used only when a measured workload requires them, not as the
universal interoperability mechanism.

## Contract ownership and types

Each capability must own its own cross-language contract. Dads must not
create one global intermediate representation that becomes a shared ownership
trap.

The contract must:

- Describe serializable input, output, expected errors, and streaming behavior.
- Generate natural types for TypeScript and each supported guest language.
- Validate values at both sides of the runtime boundary.
- Be versioned independently from the guest library and transport.
- Prevent foreign library types from appearing in application-facing surfaces.
- Produce inspectable generated artifacts with automated drift checks.

The exact source format—a Dads schema, WIT, Protocol Buffers, or another
interface language—is intentionally undecided until a concrete experiment tests
the tradeoffs.

## Call and data model

Cross-runtime calls should be explicitly asynchronous. The host should not make a
process or network boundary pretend to be a synchronous local function.

The initial value model should favor:

- Records, tagged variants, lists, optional values, and typed results.
- Explicit identifiers, timestamps, and binary values.
- Bounded requests and responses.
- Streaming for large or incremental data.
- Explicit resource handles when a foreign object cannot be serialized.

The boundary should not attempt to share arbitrary classes, closures, callbacks,
threads, or heap objects between runtimes.

Capability APIs should be coarse enough to express an application operation.
Thousands of tiny cross-process property calls would indicate that the foreign
library's API leaked through instead of being mapped into an owned capability.

## Lifecycle responsibilities

The host would need one consistent lifecycle for every guest:

1. Resolve and verify the declared guest artifact.
2. Start it with an explicit environment and resource grants.
3. Perform a protocol and capability-version handshake.
4. Wait for readiness before accepting work.
5. Route calls, deadlines, cancellation, and streams.
6. Observe health and resource usage.
7. Drain in-flight work during shutdown.
8. Terminate the guest and release resources.

Crash recovery and retries must be explicit. The host must not retry a mutation
unless the capability declares the operation safe to repeat or supplies an
idempotency mechanism.

## Failure model

Expected application failures belong to the capability contract. Runtime
failures belong to the host and must map into a small typed set, such as:

- Guest unavailable.
- Incompatible capability or protocol version.
- Deadline exceeded.
- Call cancelled.
- Guest crashed.
- Resource limit exceeded.
- Malformed or invalid guest response.
- Host permission denied.

Guest stack traces and library exceptions must not escape as application errors.
They may be retained in appropriately redacted operational diagnostics.

## Security and permissions

Two permission systems must remain distinct:

1. Application authorization decides whether the current subject may perform the
   capability operation.
2. Runtime permissions decide what the guest process may access on the host.

Application authorization should normally occur before the guest call. Moving an
implementation into Python must not move business access policy into Python.

The guest should receive only explicitly granted access to:

- Files and directories.
- Network destinations.
- Environment variables and secrets.
- Child-process creation.
- CPU, memory, execution time, and concurrency.
- Host capabilities exposed to a WebAssembly component.

A normal operating-system child process is crash isolation, not a security
sandbox. Running untrusted third-party code would require a stronger isolation
model and is not an initial promise.

## Testing and proof

The polyglot host is valuable only if it strengthens Dads's testing model.

- Application behavior should remain testable through an in-memory capability
  implementation.
- Every guest implementation must run the same capability conformance suite as
  native implementations.
- A real integration test must start the packaged guest and exercise the actual
  foreign library.
- Composition tests must prove that the selected proxy and guest artifact are
  connected.
- Fault tests must cover startup failure, incompatibility, timeout, cancellation,
  guest crash, malformed responses, and shutdown with in-flight work.
- Packaging smoke tests must prove the artifact starts in each supported target
  environment.
- Performance tests must measure boundary overhead using realistic payloads and
  call patterns.

The shared conformance suite is the behavioral contract. Successful message
exchange alone is not proof that two implementations mean the same thing.

## Observability

Calls should preserve one trace across the TypeScript host and guest process.
Operational evidence should identify:

- Capability and implementation version.
- Guest instance and execution backend.
- Call duration, queue time, and payload size classes.
- Timeouts, cancellation, restarts, and resource-limit events.
- Sanitized guest logs and failure diagnostics.

Logs and traces must not expose secrets, raw documents, model inputs, or other
sensitive application data by default.

## Packaging and deployment

A guest implementation is more than source code. Its artifact must declare or
contain:

- Runtime and supported version.
- Locked language dependencies.
- Native or system dependencies.
- Entry point and startup protocol.
- Supported operating systems and architectures.
- Capability and protocol versions.
- Required runtime permissions.
- Health and shutdown behavior.

The host should fail during build, startup, or deployment validation when these
requirements are missing. It should not discover an absent interpreter or
incompatible native library on the first customer request.

Warm workers should be preferred for repeated calls. Per-call process startup is
appropriate only for rare isolation-sensitive work and must be an explicit
tradeoff.

## Difficulty calibration

A narrow proof with one capability, one guest language, and one managed process
is achievable without inventing a new programming language or compiler.

A reliable framework subsystem supporting generated bindings, packaging,
lifecycle, security, streaming, observability, fault handling, and several
languages is substantial but bounded.

A promise to transparently import any package from any language with local-call
semantics would be unbounded and misleading. Dads should never make that
promise.

## First experiment

The first experiment should happen only after Dads's core reference
application works.

It should:

1. Select one foreign-language library with a meaningful advantage over credible
   TypeScript alternatives.
2. Define one narrow application-owned capability around the user need.
3. Implement one managed-process backend and one guest language.
4. Generate or derive bindings from one capability-local contract.
5. Provide both an in-memory TypeScript implementation and the real guest
   implementation.
6. Run one conformance suite against both.
7. Prove composition can switch between them without consumer changes.
8. Kill, stall, and misconfigure the guest to prove typed failure behavior.
9. Measure startup, request overhead, memory, and realistic throughput.
10. Record whether the host removed more complexity than it introduced.

Document understanding, scientific computation, computer vision, specialized
industrial SDKs, or a performance-sensitive parser could be suitable experiments,
but the choice must follow a real application need.

## Acceptance criteria for a future implementation

The idea earns promotion into a Dads goal only when an experiment proves:

- TypeScript consumers import no guest-runtime or foreign-library types.
- The capability contract produces usable, checked bindings on both sides.
- The handwritten guest adapter contains semantic mapping rather than repetitive
  transport plumbing.
- The in-memory, native if present, and guest implementations pass the same
  behavioral contract.
- Switching implementation language changes only composition and deployment.
- Deadlines, cancellation, incompatibility, crashes, invalid responses, and
  shutdown are handled predictably.
- Runtime permissions are explicit and default to the minimum required access.
- The packaged guest starts reproducibly in every declared target environment.
- Observability crosses the runtime boundary without leaking sensitive values.
- Measured overhead is acceptable for the selected application operation.
- Using the foreign library creates enough value to justify the runtime boundary.

## Non-goals

This idea does not initially attempt to:

- Import foreign packages directly from TypeScript syntax.
- Eliminate the semantic guest adapter.
- Share arbitrary memory or object identity between languages.
- Make cross-process calls appear synchronous.
- Support every language, package manager, or operating system.
- Make every Dads capability remotely executable.
- Run untrusted marketplace plugins without a real sandbox.
- Replace ordinary services when independent deployment is already appropriate.
- Provide browser-local foreign-language execution.
- Influence the current reference application's design without a concrete need.

## Browser-local execution is a separate idea

A future browser runtime could potentially load compatible WebAssembly
components and generate browser-side bindings. It would have different security,
package-size, startup, browser-API, threading, persistence, and toolchain
constraints.

The server host should neither promise browser compatibility nor prevent a later
browser-specific design from using the same application-owned capability where
that is genuinely appropriate.

## Open questions

The first experiment should answer rather than speculate about:

- Which contract format best preserves Dads ownership while generating
  natural bindings?
- Which local transport provides the right simplicity, streaming, and debugging
  experience?
- Which guest language should receive first-class support first?
- How should guest artifacts be built, cached, and distributed?
- What isolation boundary is sufficient for trusted application code?
- How are backward-compatible capability and protocol changes expressed?
- Which resource controls work consistently across local development and
  deployment?
- When should a guest remain local versus become an independently deployed
  service?

## Decision gate

Do not begin implementation until all of these are true:

- The core Dads framework and first reference application are working.
- A real application needs a library whose value materially exceeds credible
  TypeScript alternatives.
- Rewriting the behavior or operating a conventional service is demonstrably
  less attractive.
- The experiment can be scoped to one capability, one guest language, and one
  execution backend.

If those conditions never occur, Dads loses nothing by leaving this as a
documented idea.

## Background technologies to evaluate later

- [WebAssembly Component Model and WIT](https://component-model.bytecodealliance.org/design/wit.html)
- [WASI roadmap](https://wasi.dev/roadmap)
- [gRPC and Protocol Buffers](https://grpc.io/docs/what-is-grpc/introduction/)
- [Node-API](https://nodejs.org/api/n-api.html)

These are candidate building blocks, not committed dependencies.

## Recommended next step

None now. Complete Dads's first tangible framework slice. Revisit this
proposal only when a concrete foreign-language library creates real pressure for
it.
