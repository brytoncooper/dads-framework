# Verification and code health

Run `npm run verify` from the application root. In the kit starter this
checks domain imports, runs TypeScript, and runs the tests. CI calls
`sh ci/verify.sh`, which installs the dependencies with `npm ci` and runs
the same verification. [Portable CI recipe](../../../ci/README.md)

The [testing quickstart](../../testing/quickstart.md) covers planning and
running selected tasks. Treat the targeted plan as feedback and use the full
verification command before releasing a change.

[Doctor](../../doctor.md) explains each code-health check and helps you
inspect the baseline. Run `dad doctor --gate` for the current tree. When
the repository has adopted a standalone baseline, compare the proposed code
and policy with a trusted base using the [standalone ratchet recipe](../../../ci/source-ratchet.md).
