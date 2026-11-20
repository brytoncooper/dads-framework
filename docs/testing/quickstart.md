# Five minutes with Dad

You already know which tests your change probably broke. The problem is that
"probably" is doing a lot of work, so the suite reruns everything and nobody
ever finds out which of you was right. This is that argument, settled once.

## 1. Install

Use a built source checkout while the first public npm release is on hold.
Follow the [native build instructions](../../packages/testing/core/README.md#native-packages),
then make the checkout's `node_modules/.bin` available on your shell's `PATH`:

```sh
# Run from the built Dads framework checkout.
export PATH="$PWD/node_modules/.bin:$PATH"
export DADS_TEST_NATIVE_BINARY="$PWD/target/debug/dad-test"
```

The example starts from a committed three-package npm workspace with its own
lockfile. `core` defines `test` and `typecheck`. `api` and `web` each
define `test` and declare a workspace dependency on `core`. Run the remaining
commands from that workspace root.

## 2. Write the manifest

```sh
dad-test init
```

```
init: wrote dads.testing.json (3 projects, 4 tasks) validation=native selected=4
report: dads.testing.init-report.json
```

`init` read the workspace, turned the `test` and `typecheck` scripts into
tasks, and validated the manifest through the native engine. Review and commit
`dads.testing.json`, then move the init report outside the working tree so
the next plan sees only the source edit.

## 3. Make a change

Add a dynamic import to `packages/core/src/loader.ts`:

```ts
export const pick = (name: string) => import(`./${name}.js`);
```

## 4. Ask why

```sh
dad-test explain
```

```
explain: 4 of 4 tasks selected, 0 skipped, 3 widened detail=engine
scope: kind=working-tree base=76a9bb12 head=76a9bb12 changed=1
full-fallback: no
RUN api:test project=api reason=graph-uncertainty-project-fallback confidence=conservative widened=yes
  because graph proof incomplete; widened through fallback dependencies
  issue nonliteral-dynamic-import packages/core/src/loader.ts:2:46 A dynamic import does not have a static module specifier.; widened through declared project dependencies.
  fallback-dependency core
RUN core:typecheck project=core reason=changed-owned-project confidence=conservative widened=no
  because a changed path is owned by this project
  changed packages/core/src/loader.ts
RUN core:test project=core reason=graph-uncertainty-project-fallback confidence=conservative widened=yes
  because graph proof incomplete; widened through fallback dependencies
  issue nonliteral-dynamic-import packages/core/src/loader.ts:2:46 A dynamic import does not have a static module specifier.; widened through declared project dependencies.
RUN web:test project=web reason=graph-uncertainty-project-fallback confidence=conservative widened=yes
  because graph proof incomplete; widened through fallback dependencies
  issue nonliteral-dynamic-import packages/core/src/loader.ts:2:46 A dynamic import does not have a static module specifier.; widened through declared project dependencies.
info graph-initial-index Persisted graph analysis state under Git metadata.
```

The planner selected `core:typecheck` because `core` owns the changed path. The three
`test` tasks are marked `widened=yes` because the template literal at
`packages/core/src/loader.ts:2:46` has no static module specifier, so the
symbol graph cannot say what `pick` reaches. Dads answered that uncertainty by
widening from `core` through its declared `fallbackDependencies` to `api` and
`web` — not by falling back to the whole workspace, which is why
`full-fallback` is `no`.

## 5. See a proven skip

Undo the dynamic import, and instead change the body of an exported function
in `core` that only `api` imports. Now `explain` prints
`SKIP web:test ... reason=proven-unaffected`, and the selected tasks carry
`changed`, `export`, and `import` cause lines naming the file that changed,
the export that changed with it, and the import in `api` that reaches it.
`proven-unaffected` is the only skip Dads will take.

## 6. Read the report

To reproduce the metrics below, revert the function edit and reapply the
dynamic-import change.

```sh
dad-test plan --report dads-testing-report.json --json
```

For the dynamic-import change, `projectClosure` reports
`closureTaskCount: 4`, `selectedTaskCount: 4`, `reductionRatio: 1`, and a
`byReason` split of `graph-uncertainty-project-fallback: 3` and
`changed-owned-project: 1`. `reductionRatio` is the selection as a fraction of
what a project-closure tool would have run, so `1` means Dads ran exactly as
much this time — the honest price of an import it could not resolve.

## 7. Wire it into CI

Make the target branch available in the CI checkout. For a change targeting
`main`, run:

```sh
dad-test run --base origin/main --json
```

Archive the JSON per run. When a result surprises someone, `dad-test explain`
with the same refs prints the reasoning behind it.

Use the [testing package reference](../../packages/testing/core/README.md)
when you need the manifest fields, task flags, or report contract.
