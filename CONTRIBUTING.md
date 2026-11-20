# Contributing

Dads source is licensed under the [MIT License](./LICENSE.md).

## Working on the code

```sh
npm ci
npm run verify
```

`npm run verify` runs the repository gate, including formatting, lint,
typechecks, tests, dependency boundaries, and the budgets. Use
`npm run verify:full` for the additional CI proofs, including adoption from
local tarballs, Rust checks, and testing soundness. `npm run verify:release`
requires a clean committed checkout and adds uncached verification and package
preflight. See the [release verification commands](./ci/README.md#framework-prerelease-verification).
Submit contributions through a branch and pull request.

The rules `verify` enforces — the compiler flags, the lint scopes, the Rust
denies, the package boundaries, the public-surface reports, and the
source-budget ratchet — are listed in
[docs/house-rules.md](./docs/house-rules.md) with the fix command for each.
`npm ci` also wires the tracked Git hooks. The commit hook checks staged
changes. The push hook requires a verification receipt for the commit being
pushed and runs verification if it needs a new receipt.

Read `AGENTS.md` before changing anything. It is short and binding.

## Continuous integration

The [CI catalog](./ci/README.md) provides a shared shell job for adopter
projects and optional GitHub Actions and GitLab CI adapters. Use the adapter
for your runner or run `sh ci/verify.sh` from an existing pipeline. The
framework's own workflow splits its full verification across several jobs.

## Writing docs

A change to a public surface — an export, a CLI command or option, an error —
updates that package's README in the same change. Follow
[`docs/package-readme-template.md`](./docs/package-readme-template.md) for the
section order, and [`docs/style-guide.md`](./docs/style-guide.md) for the two
registers the prose is written in.

`node scripts/checks/check-docs.mjs` checks that structure, and that the
`@dads-framework/testing` README still covers every `dad-test` command and
option. It runs inside `npm run verify`.

## Licensing of contributions

By submitting a contribution you agree that:

- your contribution is licensed to the project under the license in
  `LICENSE.md` at the time of submission; and
- the maintainer may relicense the project, including your contribution,
  under the Apache License 2.0 or the MIT License in the future.

If you cannot agree to that, please open an issue to discuss before writing
code.

## Reporting problems

Bugs and questions go in GitHub issues. Security problems do not; see
[SECURITY.md](./SECURITY.md).
