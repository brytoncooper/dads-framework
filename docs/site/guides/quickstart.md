# Quickstart

Create a local Dads project, sign in, and save a note. The starter runs a
web app, PostgreSQL, and separate customer and staff APIs.

## Create the project

Use Node 24, npm, and Docker with the Compose v2 plugin. Start Docker and run
the creator from the directory where you want the new `my-app` folder.

Use `create-dads` 0.3.0 for this walkthrough.
For an exercise you can run from a source checkout,
[try the Workbench API](#try-the-workbench-api-from-source).

[Creator command reference](../../../packages/foundation/create-dads/README.md#try-it)

<!-- dads:excerpt {"path": "packages/foundation/create-dads/README.md", "language": "sh", "from": "npm create dads@0.3.0 my-app", "through": "cd my-app"} -->

The creator installs dependencies, writes `package-lock.json`, starts the
Compose stack, and runs the database migrations. Watch for the `Open`,
`Customer API`, and `Staff API` lines. These report the assigned local URLs
after the services respond. Open the URL on the `Open` line. The app shows
a sign-in form.

Use `npm config get registry` to identify your registry and
`npm view create-dads@0.3.0 version` to check whether it carries 0.3.0.

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

## Find the code behind Add note

These paths are relative to the generated app root.

```text
apps/
  customer/app.ts
  staff/app.ts
  web/note-forms.tsx
domains/
  notes/
    index.ts
    access/index.ts
    contract/index.ts
    contract/wire.ts
    server/plugin.ts
    server/routes.ts
    web-client/index.ts
tests/
  starter.integration.test.ts
```

1. `apps/web/note-forms.tsx` calls `createNote` from
   `domains/notes/web-client/index.ts`. The client and route share the
   schemas in `domains/notes/contract/`. [Read the request and response code](./http.md)
2. `apps/customer/app.ts` mounts the Notes plugin through
   `domains/notes/index.ts`. The plugin passes the app's services to the
   route in `server/routes.ts`. [Trace the API selection](./composition.md)
3. `domains/notes/access/index.ts` selects the workspace permission.
   `tests/starter.integration.test.ts` checks the member's write and read,
   cross-tenant denial, and the staff API's response for the same URL.
   [Read and run the denial test](./guarded-resource.md#prove-denial-with-a-signed-in-outsider)

For an owner, member, and outsider in one prepared workspace, run
`npm run examples:setup` in the running generated app. The
[starter exercises](../../../apps/kit-workbench/examples/README.md) explain
how to use those accounts.

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

Follow the [resource scaffold](./guarded-resource.md#scaffold-another-resource)
to add a resource with a permission and prove denial in a test. Run
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
