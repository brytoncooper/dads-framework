# Quickstart

Create a local Dads project, sign in, and save a note. The starter runs a
web app, PostgreSQL, and separate customer and staff APIs.

## Create the project

Use Node 24, npm, and Docker with the Compose v2 plugin. Start Docker and run
the creator from the directory where you want the new `my-app` folder.

Use the commands below when your registry carries a stable `create-dads`
release. The public npm `latest` tag currently points to a staging version.
For an exercise you can run from a source checkout,
[try the Workbench API](#try-the-workbench-api-from-source).

[Creator command reference](../../../packages/foundation/create-dads/README.md#try-it)

<!-- dads:excerpt {"path": "packages/foundation/create-dads/README.md", "language": "sh", "from": "npm create dads@latest my-app", "through": "cd my-app"} -->

The creator installs dependencies, writes `package-lock.json`, starts the
Compose stack, and runs the database migrations. Watch for the `Open`,
`Customer API`, and `Staff API` lines. These report the assigned local URLs
after the services respond. Open the URL on the `Open` line. The app shows
a sign-in form.

Check your configured registry with `npm config get registry` and its
selected version with `npm view create-dads@latest version`.

## Save a note

1. Select **Create an account**, enter a local email such as
   `reader@example.test`, and submit the form.
2. In a terminal in `my-app`, run `npm run dev:mail`. Open the verification
   link from the local mailbox. If the message has just been sent, allow a
   moment for delivery and run the command again.
3. Sign in with the same email and password. Enter a workspace name and
   select **Create workspace**.
4. Enter text in **New note** and select **Add note**. The note appears in
   the active workspace.

The web app uses the customer API. To follow the request through the
project, open these files from `my-app`:

| Path                              | What to look for                                            |
| --------------------------------- | ----------------------------------------------------------- |
| `domains/notes/contract/index.ts` | The notes schemas and their public exports.                 |
| `domains/notes/access/index.ts`   | The tenant permission shared by the notes routes.           |
| `domains/notes/server/routes.ts`  | The notes routes and the tenant scope on their data access. |
| `apps/customer/app.ts`            | The entrypoint that mounts the tenants and notes plugins.   |
| `apps/staff/app.ts`               | The entrypoint that mounts tenant routes only.              |

The [starter integration test](../../../apps/kit-workbench/tests/starter.integration.test.ts)
checks that a member can read their workspace's notes, cross-tenant access
is denied, and the staff API has no notes route.

## Restart or stop the app

- If startup fails after the project and lockfile are written, fix the
  reported error, check Docker is running with `docker info`, then run
  `npm start` from `my-app`.
- Run `npm run dev:status` to look up the current local URLs. Ports can
  change after a restart.
- Run `npm run dev:down` to stop the stack and keep its data. Run
  `npm start` to bring it back.

See [local development](../../../apps/kit-workbench/assembly/LOCAL-DEV.md)
for details on Compose, logs, and the local mailbox.

## Make your first change

Follow the [guarded resource walkthrough](./guarded-resource.md) to add a
resource with a permission and prove denial in a test. Run
`npm run verify` from the project root with Docker running to check your
changes before adding the same command to [CI](../../../ci/README.md).

## Try the Workbench API from source

The repository includes a reference task API that uses the same HTTP and
permission packages as the Notes starter. With Node 24 and Docker running,
start it from the framework checkout.

```sh
npm ci
npm run workbench:dev
```

Once the API is ready, send this request from another terminal.

```sh
curl -fsS http://127.0.0.1:4317/api/workspaces \
  -H 'x-workbench-user: alice'
```

The response lists the workspaces visible to the local demo identity Alice.
Press Ctrl+C in the launcher terminal or run `npm run workbench:stop`.
To exercise the Notes creator against local package tarballs, run
`npm run verify:adoption` from the framework checkout.
[Workbench source guide](../../../apps/workbench/README.md)
