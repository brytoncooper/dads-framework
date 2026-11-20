# Contributing

Dads source is licensed under the [MIT License](./LICENSE.md).

## Working on the code

Read [AGENTS.md](./AGENTS.md) for ownership and verification rules. Use Node 24
and npm, as the framework CI does. Start Docker with Compose v2 for PostgreSQL
integration and starter adoption proofs. For native testing changes, use the
Rust version in [rust-toolchain.toml](./rust-toolchain.toml).

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
Open a pull request from your branch. Include the commands you ran and any
verification you could not complete.

The rules `verify` enforces — the compiler flags, the lint scopes, the Rust
denies, the package boundaries, the public-surface reports, and the
source-budget ratchet — are listed in
[docs/house-rules.md](./docs/house-rules.md) with the fix command for each.
`npm ci` also wires the tracked Git hooks. The commit hook checks staged
changes. The push hook requires a verification receipt for the commit being
pushed and runs verification if it needs a new receipt.

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

For a public guide, edit the Markdown source and update
[`docs/site/catalog.json`](./docs/site/catalog.json) when adding a page.
Keep existing page slugs and section anchors when other pages link to them.
Link to runnable examples and their proof instead of duplicating code in guides.

Run `npm run docs:build` to preview the generated pages in `dist/dads-docs`.
The repository gate checks the docs site, package README structure, and
`dad-test` option coverage.

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
