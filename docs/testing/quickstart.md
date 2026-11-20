# Five minutes with Dad

You already know which tests your change probably broke. The problem is that
"probably" is doing a lot of work, so the suite reruns everything and nobody
ever finds out which of you was right. This is that argument, settled once.

## 1. Install

Install the npm package. npm selects the optional executable package for a
supported platform.

```sh
npm install --save-dev @dads-framework/testing
```

[Testing package and native support](../../packages/testing/core/README.md)

The example below is a three-package npm workspace: `core`, plus `api` and
`web` which both depend on it. Each package has `test` and `typecheck`
scripts.

## 2. Write the manifest

```sh
npx dad-test init
```

```
init: wrote dads.testing.json (3 projects, 4 tasks) validation=native selected=4
report: dads.testing.init-report.json
```

`init` read the workspace, turned the `test` and `typecheck` scripts into
tasks, and validated the manifest through the native engine. Open
`dads.testing.json` and correct anything it guessed wrong.

## 3. Make a change

Add a dynamic import to `packages/core/src/loader.ts`:

```ts
export const pick = (name: string) => import(`./${name}.js`);
```

## 4. Ask why

```sh
npx dad-test explain
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

```sh
npx dad-test plan --report dads-testing-report.json --json
```

For the dynamic-import change, `projectClosure` reports
`closureTaskCount: 4`, `selectedTaskCount: 4`, `reductionRatio: 1`, and a
`byReason` split of `graph-uncertainty-project-fallback: 3` and
`changed-owned-project: 1`. `reductionRatio` is the selection as a fraction of
what a project-closure tool would have run, so `1` means Dads ran exactly as
much this time — the honest price of an import it could not resolve.

## 7. Wire it into CI

```sh
npx dad-test run --base origin/main --json
```

Archive the JSON per run. When a result surprises someone, `dad-test explain`
with the same refs prints the reasoning behind it.

That is the whole thing: the answer you would have gotten in the driveway in
eleven seconds, with the file and line attached so nobody has to take your
word for it.
