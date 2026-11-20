# CI for Dads projects

Run this from a clean checkout at the project root with Node 24 and npm.

```sh
sh ci/verify.sh
```

The [shared script](./verify.sh) sets `CI=true`, installs the dependencies
from `package-lock.json` with `npm ci`, and runs the root `npm run verify`
script. Set `verify` to the complete set of checks that must pass before
merging. The kit starter runs domain boundary checks, TypeScript checks, and
tests, including its permission-denial proofs.

Commit `package-lock.json` and configure registry access for private
dependencies. New Dads starters include the shell entry point and both
templates. Existing projects can copy the shell script and add its command to
their current pipeline.

| Runner                                  | Enable verification                                                                                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Actions                          | Copy [the adapter](./github-actions/verify.yml) to `.github/workflows/verify.yml`, or add its `verify` job to an existing workflow. It runs on pushes, pull requests, and manual dispatch. Checkout uses read-only contents access and does not persist credentials. |
| GitLab CI                               | Copy [the adapter](./gitlab/verify.yml) to `.gitlab-ci.yml`, or add its `verify` job to your pipeline. It runs for branch pushes and merge requests, with one pipeline per change when a merge request is open.                                                      |
| Self-hosted shell or another CI service | Check out the commit under review, provide Node 24 and npm, and run `sh ci/verify.sh`. Configure the runner to trigger on the pushes or reviews you intend to gate.                                                                                                  |

Enable the adapter for the runner you use. Keep existing workflow definitions
and merge the verification job into them when appropriate. For an application
in a subdirectory, run the shell command from the application's root. Make
`verify` required in your merge rules if you want the service to block merges.

`npx dad doctor --issue its-not-you-its-my-boundaries` can check whether a
tracked CI definition it recognizes invokes the gate. For an external runner
configured outside the repository, check that runner's job history.

## Maintain the templates

Edit the shared script or adapter here. Regenerate the files bundled with
Toolbox and test the shell job in a disposable starter.

```sh
node scripts/build/sync-starter-workflow.mjs
node scripts/build/sync-starter-workflow.mjs --check
npm test -w @dads-framework/toolbox -- starter-verification.test.ts
```

The framework repository runs its own full verification graph across multiple
jobs. The adapters in this catalog target adopter projects.

## Framework prerelease verification

Run `npm run verify:release` from a clean committed framework checkout in the
prerelease job with Gitleaks installed. The command prepares the MIT notices,
runs uncached verification, and scans the actual local package archives with
the built-in policy and Gitleaks. It creates no public release.

When a release needs additional organization-specific checks, set
`DADS_RELEASE_PRIVATE_PATTERNS` to a reviewed pattern file outside the release
payload. The ignored local pattern file also applies when present.

Run `npm run release:preflight` after the build and notice preparation to inspect
the packed artifacts independently. The package publication hook repeats the
artifact check even when the committed source already has a full proof receipt.

The audit package starts empty databases with a neutral baseline. Validate
future migration changes against both a fresh database and any previously
applied Dads journal affected by the change.

When a release must be screened against organization-specific identifiers, keep
the policy outside the exported tree. Run the source preflight on the exact
checkout to be published. Use the same rule file for the packed artifacts.

```sh
node scripts/checks/check-private-references.mjs --private-patterns "$PRIVATE_POLICY"
DADS_RELEASE_PRIVATE_PATTERNS="$PRIVATE_POLICY" npm run verify:release
```

An explicitly supplied policy must be a nonempty JSON array. Each rule has an
`id`, `regex`, and `reason`. Set `scope: "path"` for filename checks. The
`files` regex can restrict a rule to selected paths. Use neutral IDs so reports
can identify the rule without disclosing the matched text.
