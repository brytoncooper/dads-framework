# Adopt one capability

Dads libraries work in an existing TypeScript application. Pick the capability
your app needs and configure its driver where your application starts. The
full starter is available when you want the API, database, and workbench
assembled for you.

## Try file storage in your own project

From a Node.js project, install the storage package.

```sh
npm install @dads-framework/object-storage
```

Save this as `storage-demo.mjs` and run `node storage-demo.mjs`.

<!-- dads:excerpt {"path": "apps/kit-workbench/examples/standalone-storage.ts", "language": "ts", "from": "import { createObjectStorage } from \"@dads-framework/object-storage\";", "through": "if (note) process.stdout.write(new TextDecoder().decode(note.body) + \"\\n\");"} -->

It prints `Hello from Dads`. In your app, put the factory call in your own
config file and pass `storage` to the code that handles uploads. The same
`put` and `get` calls work with disk or S3. In Dads 0.3, memory and disk
work with just this install. The S3 driver uses the AWS packages listed in
the [storage setup](../../../packages/server/object-storage/README.md).

## Choose a standalone system

In the table, package names use the `@dads-framework/` scope, except for
`create-dads`. For example, install `@dads-framework/feature-flags` for flag
evaluation. Its `/postgres` and `/http` entry points let you add persistence
and routes separately. Each adapter's guide lists its required peers.

| What you want to add         | Where to start                                                                                               | When to add another package                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed API                    | `http` for routes and health probes, `contract` for shared schemas                                           | `client-request-transport` for a browser client, `plugin` for composing APIs                                                                                |
| Permissions                  | `access` for the relationship model                                                                          | `postgres-access` for transactional checks in Postgres, or `authorization` and `authorization-migration` for the SpiceDB integration and its schema journal |
| Login and company membership | `identity` for session contracts and the SCIM handler                                                        | `identity-better-auth` for the auth and SSO adapter, `tenants` for memberships and invitations                                                              |
| Email                        | `email-sender` for capture, log, Mailgun or Resend                                                           | `email-templates` for React rendering, `email-delivery` for durable delivery                                                                                |
| Files and jobs               | `object-storage` for files, `job-queue` for jobs and schedules                                               | Select S3 or Redis in app config when you need those services. Both libraries include local drivers.                                                        |
| Feature flags                | `feature-flags` for evaluation, HTTP routes and Postgres storage                                             | `client-feature-flags` adds the React integration                                                                                                           |
| Logs and traces              | `runtime/diagnostics` for reporting, `telemetry` for server traces                                           | `client-telemetry` instruments the browser                                                                                                                  |
| Audit and data               | `audit` for recording and exporting changes, `audit-actor` for attribution alone                             | `postgres` manages a shared database connection, `migrations` runs schema changes, `cross-domain-references` finds dangling references                      |
| Application building blocks  | `runtime` for clock, request work and diagnostics, `errors` for typed failures, `event-bus` for local events | Import the runtime subpath you use, such as `@dads-framework/runtime/clock`                                                                                 |
| Document formats             | `csv`, `pdf`, or `client-xlsx`                                                                               | Pick by format. Spreadsheet and PDF dependencies stay with the selected library.                                                                            |
| Web UI                       | `ui` for React components                                                                                    | `copy` for localized text, `design-tokens` for shared design values, `styles` for CSS                                                                       |
| Developer tools              | `testing` for verification and Nx import, `toolbox` for the Dad CLI                                          | `testing-vitest` connects Vitest, `path-aliases` resolves TypeScript paths, `dev` manages local development environments                                    |
| A complete app               | `npm create dads@latest my-app`                                                                              | The creator installs and starts the reference stack. The testing CLI selects a native binary for your operating system and CPU.                             |

For a walkthrough of adding validation and authorization to an existing API,
see the [HTTP contract example](./http.md) and [denial test](./guarded-resource.md).

## Preview a starter beside your application

An isolated starter lets you practice on a working API before editing your
application. Run this preview with `create-dads` 0.3.0 and the root of your
existing application as the target.

```sh
npm create dads@0.3.0 /path/to/your/project -- --existing --dry-run --json
```

Check that `initialization.projectRoot` points to the project's `dads/`
subdirectory. `initialization.created` lists the starter files it would write.
Remove `--dry-run` to write those files and install dependencies. The host
manifest stays intact. With Docker running, start the separate app.

```sh
cd /path/to/your/project/dads
npm start
```

Open the web URL printed by the launcher and [save a note](./quickstart.md#save-a-note).
Commit the starter's `package-lock.json` if you use its CI. Its
`ci/verify.sh` runs `npm ci` before verification.

From a framework checkout, you can preview the same layout with the source
creator.

```sh
npm ci
npm run build
node packages/foundation/create-dads/dist/cli.js /path/to/your/project \
  --existing --dry-run --json
```

If the host already has the [Toolbox](../../../packages/foundation/toolbox/README.md),
run `npx dad doctor` in the host to inspect its current findings. Use
`npx dad doctor explain <issue-id>` to read the rule and the suggested repair.
[Doctor reference](../../doctor.md)
