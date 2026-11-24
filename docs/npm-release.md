# npm release

The **Prepare npm release artifacts** workflow on the public repository builds, tests, and signs the exact release tarballs. The workflow has no npm credentials. Only its signing job can request a GitHub OIDC identity. The npm organization maintainer stages and approves releases from their own workstation.

## Release scopes

The workflow accepts a `scope` input so `@dads-framework/testing` and its five platform binary packages can ship independently without republishing untouched framework packages:

- **`testing` (6 packages):** `@dads-framework/testing` plus the five `@dads-framework/testing-native-*` packages, versioned by `packages/testing/core/package.json` (currently `0.7.0`). Wave 1 is the five native binary packages; Wave 2 is `@dads-framework/testing`.
- **`all` (24 packages):** All 18 framework packages (versioned by root `package.json`, currently `0.6.5`) plus the 6 testing packages (versioned by `packages/testing/core/package.json`).

## Prepare and verify the release

1. Run **Prepare npm release artifacts** from `main`, selecting `scope: testing` (for testing-only releases) or `scope: all` (for full framework releases). Use the complete workflow when retrying so every artifact comes from the same run attempt.
2. Download only the `dads-npm-release-<scope>-<commit>-<attempt>` artifact from a successful run. Keep every tarball and Sigstore bundle listed in `release.json` together with the manifest. Check out that public commit on the operator's workstation.
3. Use Node 24 and npm 11.21.2. From the release commit's checkout, set
   `release_dir` to the absolute path of the extracted artifact directory
   containing `release.json`. Verify the contents and provenance before
   using the archive filenames in npm commands (`sign-release.mjs verify` reads
   `scope` from `release.json` and verifies the exact inventory for that scope).

```bash
tooling=$(mktemp -d)
npm install --prefix "$tooling" --registry=https://registry.npmjs.org/ --ignore-scripts --no-audit --no-fund --save-exact npm@11.21.2
npm_release="$tooling/node_modules/npm"
node scripts/release/sign-release.mjs verify "$release_dir" "$npm_release"
node "$npm_release/bin/npm-cli.js" whoami --registry=https://registry.npmjs.org/
```

Use the npm session of an organization maintainer with publish rights. Complete authentication on that workstation.

## Stage and approve

For each entry, use the `filename` and `provenance` paths in `release.json`. Run the npm commands from the release artifact directory. Stay within this exact inventory and use the explicit `latest` tag for stable releases.

```bash
node "$npm_release/bin/npm-cli.js" stage publish "./$filename" \
  --provenance-file="./$provenance" --access public --tag latest \
  --registry=https://registry.npmjs.org/ --ignore-scripts --json
```

Retain each returned stage ID. Review each package name, version, tag and checksum before approving with 2FA. Use the numbered dependency waves in the manifest when approving. Finish publishing and checking one wave before approving the next.

### Resume safely

- Check `npm view "$package@$version" dist --prefer-online --json`. A published version must match the manifest's SHA-512 integrity and carry provenance. An exact match can be skipped. Stop on a different digest, missing provenance, unexpected version or permission/network error.
- For a confirmed absent version, check `npm stage list "$package" --json`. Use `npm stage view "$stage_id" --json` to confirm the target and tag. Run `npm stage download "$stage_id"` from a clean temporary directory and compare that tarball's SHA-512 to the manifest. Resume the matched pending stage and stop on mismatches. Stage only missing entries.
- On npmjs.com, batch approval can cover up to 100 staged versions with one 2FA challenge when available. Approvals within a batch can succeed independently. Refresh the staging and registry views after each batch and reconcile before retrying. For individual approval use `npm stage approve "$stage_id"`.
- After publishing, read `dist.integrity` and `dist.attestations` again and compare to the manifest and expected GitHub workflow, commit and run. Complete a clean registry install and run:
  - For `testing` releases: `npx --yes --package @dads-framework/testing@0.7.0 dad-test --help`
  - For `all` releases: `npx --yes --package @dads-framework/toolbox@<version> dad --help`, `npx --yes --package @dads-framework/testing@<testing-version> dad-test --help`, and `npx --yes create-dads@<version> --help`
    Run `npm audit signatures` in that consumer environment after installing the packages.

## Set up trusted publishing for subsequent releases

A trusted publisher is registered for each existing package. Configure it just before the first OIDC release so that first successful use falls within npm's two-day binding window. Use the exact public repository slug, workflow filename, and environment if one is configured. For a workflow that stages releases, select stage-only access. The npm CLI supports bulk setup with an interactive 2FA challenge and recommends a two-second delay between registrations. [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/) · [Trusted publishing](https://docs.npmjs.com/trusted-publishers/)
