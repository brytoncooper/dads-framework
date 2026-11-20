# Start a Dads project

Use the [creator command reference](../../../packages/foundation/create-dads/README.md)
to generate a local project. Start in an empty directory
for a new app. For an existing app, read [adopt one capability](./adopt.md).

Install Node 24 and start Docker with Compose. Run
`npm create dads@latest my-app` from a parent directory.

The creator installs the Dads capability packages and writes
`package-lock.json`. It starts PostgreSQL, runs the migrations, and waits
for the web app, customer API, and staff API to respond on assigned local
URLs. Open the printed browser URL to create an account and verify it,
create a tenant, and add your first note. Follow the
[starter README](../../../apps/kit-workbench/README.md#start) for the local
email verification steps.

From the generated directory, run `npm start` to start the stack again,
`npm run dev:status` to inspect its state, or `npm run dev:down` to stop it.
If startup is incomplete after dependencies are installed, resolve the
reported issue and run `npm start` to continue.

## Verify and set up CI

Commit the generated `package-lock.json`. Run `npm run verify` from the
project root. The generated `ci/verify.sh` installs that lockfile with
`npm ci` and runs the same checks in CI. Select a template with the
[portable verification recipe](../../../ci/README.md).

Use the [guarded resource walkthrough](./guarded-resource.md) to trace the
first permission from its definition through an HTTP test. From a framework
checkout, `npm run verify:adoption` exercises the locally packed creator,
generators, and generated CI. The
[creator CLI tests](../../../packages/foundation/create-dads/src/cli.test.ts)
exercise the executable and its startup failure output.

Local email verification is for development. Use the real mail and
database configuration described in [sign-in and tenants](./identity-tenants.md)
when proving a deployment. Follow the
[host-neutral run guide](../../../apps/kit-workbench/DEPLOY.md) for the first
migration and startup on your host or container.
