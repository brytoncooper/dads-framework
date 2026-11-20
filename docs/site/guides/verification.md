# Verification and code health

Run `npm run verify` from the application root. In the kit starter this
checks domain imports, runs TypeScript, builds the web app, and runs the tests.
Keep Docker running for the PostgreSQL integration tests. CI calls
`sh ci/verify.sh`, which installs the dependencies with `npm ci` and runs
the same verification. [Portable CI recipe](../../../ci/README.md)

For a focused pass after editing a Notes route, ask the installed testing
tool which checks the change calls for. Run `npx dad test:recommend --changed --json`.

Read each recommendation's reason and run the commands relevant to your edit.
In the starter, include the test showing a user outside the tenant receives
a denial. A successful typecheck alone leaves that behavior unproven.

The [testing quickstart](../../testing/quickstart.md) covers planning and
running selected tasks. Treat the targeted plan as feedback and use the full
verification command before releasing a change.

[Doctor](../../doctor.md) explains each code-health check and helps you
inspect the baseline. Run `dad doctor --gate` for the current tree. When
the repository has adopted a standalone baseline, compare the proposed code
and policy with a trusted base using the [standalone ratchet recipe](../../../ci/source-ratchet.md).
