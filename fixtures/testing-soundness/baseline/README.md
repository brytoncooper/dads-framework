# Testing soundness baseline workspace

This is the specimen the testing soundness corpus mutates. It is not an
application, and it owns no framework behavior.

It holds three projects — `packages/core`, `apps/api`, and `apps/web` — plus
the root `package.json`, `.oxlintrc.json`, and `vitest.config.mjs` their tasks
use. The nine tasks are declared one directory up, in
`fixtures/testing-soundness/dads.testing.json`, and the mutations and their
expected task sets are declared beside it in
`fixtures/testing-soundness/cases.json`.

`scripts/testing/testing-soundness.mjs` copies this tree into a temporary
directory, writes the manifest next to it, and commits it once as the shared
baseline. Every case is a fresh clone of that commit plus one mutation commit,
so this tree is read and never mutated in place. Evidence records the baseline
commit, its Git tree hash, and the manifest fingerprint. `node_modules` is
symlinked to the repository's already-installed pinned tools, so nothing is
installed here.

This tree is written by hand, not generated. `scripts/testing/generate-testing-soundness.mjs`
writes a different, three-project corpus into a new directory and refuses an
existing one; it does not produce this fixture.

A change to any file here changes the baseline commit and can change which
tasks a mutation moves, which is what the oracle in `cases.json` asserts
exactly. Change the two together, and re-run the corpus:

```sh
npm run testing:soundness -- --dad-test target/debug/dad-test --output /tmp/dads-testing-soundness.json
node scripts/testing/verify-testing-release.mjs --soundness /tmp/dads-testing-soundness.json
```
