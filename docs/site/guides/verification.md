# Verification and code health

After changing a Notes route, verify that a member can still read the notes
and a signed-in user outside the workspace gets a 404. From a generated
starter with Docker running, run the PostgreSQL integration test on its own.

```sh
npm test -- tests/starter.integration.test.ts
```

The test starts a disposable PostgreSQL container and creates two signed-in
accounts. The two reads below prove each member sees only their own
workspace's notes. A separate request uses Beta's session with Alpha's
workspace URL and checks for a 404.
[Starter integration test](../../../apps/kit-workbench/tests/starter.integration.test.ts)

<!-- dads:excerpt {"path": "apps/kit-workbench/tests/starter.integration.test.ts", "language": "ts", "from": "        const alphaRead = await customer.inject({", "through": "        expect(betaRead.body).not.toContain(\"Alpha's note\");"} -->

## Check the whole change

With a baseline commit in Git, ask the Toolbox to plan and run verification
for the working tree.

```sh
npx dad test:recommend --changed --json
npx dad verify --changed --json
```

For an edit to `domains/notes/server/routes.ts`, look for the `domains-notes`
task in `recommendation.tasks`. The generated starter maps this task to
`npm run verify`. Read its reason and check the verification report for the
checks that actually ran. Use the [testing quickstart](../../testing/quickstart.md)
to set up finer-grained tasks.

Before releasing, run `npm run verify`. In the generated starter that checks
domain imports, runs TypeScript, builds the web app, and runs the tests.
Commit `package-lock.json` so CI can install the same dependencies with
`sh ci/verify.sh`. [Portable CI recipe](../../../ci/README.md)

If the repository tracks its code-health findings, run `npx dad doctor --gate`.
See [Doctor](../../doctor.md) for help reading findings and the
[standalone ratchet recipe](../../../ci/source-ratchet.md) to compare a proposed
policy and code change with a trusted base.
