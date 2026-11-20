# Boundary verification fixture

This fixture is an executable correctness proof, not a demo application.

It separates authorization policy authoring from a protected consumer:

```text
src/access.ts
  -> policy:check
  -> policy:build
  -> verification/generated/policy.json
  -> consumer:artifact-check

consumer:vitest and consumer:typecheck run the actual test and type-test tools.

authorization:live also runs after policy:build and is never reusable.
```

The consumer executes the compiled `readProtectedDocument` module and parses the
serialized access schema. It does not import `src/access.ts`. Its fake-based
unit test exercises only application result handling, while its artifact test
includes the real portable engine and binding inputs. The type fixture proves
the request shape separately.

`consumer:artifact-check` may reuse a prior success only when the complete controlled
input closure and generated policy bytes match. The provider still runs first.
Source-only authoring extraction can therefore leave the consumer unchanged,
while changes to policy order, consumer source, tests, configuration, engine,
binding, lockfile, runner version, or environment execute it again.

The outer proof creates a temporary isolated Git project and never mutates this
fixture in place:

```sh
npm test -w @dads-fixture/boundary-verification
npm run typecheck -w @dads-fixture/boundary-verification
npm exec -- tsc -p fixtures/boundary-verification/type-tests/tsconfig.json --pretty false
node scripts/foundation/verify-boundary-verification.mjs
```

The final command measures actual task states across clean-checkout fallback,
baseline, unchanged output, every declared invalidation category, missing and
corrupt receipts, provider failure, and explicit full execution. It injects
failures into the artifact check, Vitest suite, and type test and requires each
real verifier to report the failure.

This finite fixture proves the two allowlisted controlled artifact adapters.
Unsupported or mutable tasks remain run-only.
