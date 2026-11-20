# Testing manifest fixture

This fixture is the smallest workspace that declares a Dads testing manifest.
It is not an application or a demo, and it owns no testing behavior.

`dads.testing.json` declares one project, `fixture`, rooted at `src`, and two
tasks: `fixture:typecheck` with project impact, and `fixture:test` with
reachability impact, which depends on it. The workspace full fallback names
both, in declaration order. The manifest is the product here; `src` holds a
single test file.

Three consumers read it, each from a different side of the package boundary:

- `crates/dads-testing-core/tests/wire_golden.rs` plans this workspace under
  the `all` operation and checks the live native response against
  `crates/dads-testing-core/tests/wire-golden/plan-response.json`. That golden
  records both task ids as `run` with reason `full-fallback`, and a run count
  of 2.
- `packages/testing/core/src/init/check-testing-manifest.test.ts` parses
  `dads.testing.json` and requires `checkTestingManifest` to report nothing.
- `src/fixture-contract.test.ts` holds the manifest against itself: the full
  fallback task ids equal the declared task ids in order, and `fixture:test`
  depends on `fixture:typecheck`.

Run the focused proof:

```sh
npm test -w @dads-fixture/testing
npm run typecheck -w @dads-fixture/testing
cargo test -p dads-testing-core --test wire_golden
```

`npm run verify:testing` reaches the first two through the workspace build and
test run. The root `tsconfig.json` references this project, so `npm run build`
compiles it.

A change here must keep four things true:

- the manifest still passes `checkTestingManifest`;
- the full fallback still lists every declared task id, in declaration order;
- `fixture:test` still depends on `fixture:typecheck`;
- the recorded wire golden still holds. Task ids, decisions, reasons, and
  counts are in it. A manifest change that moves one of those is followed by a
  hand edit of the golden; pasting a live response back into it defeats what it
  records.

The fixture depends on `@dads-framework/testing` and nothing else. Planning and
execution behavior belongs in `packages/testing/core` and the native crates.
