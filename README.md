# Dads

**A sensible framework with firm boundaries.**

Dads is a TypeScript backend framework for building strongly typed APIs.
A route declares what it accepts, what it returns, who can call it, and which
rate limits apply. Dads validates requests and generates OpenAPI documentation
from those contracts. Your typed clients can use the same schemas, and your
application logic stays plain TypeScript.

## Start your own app

Install Node 24 and start Docker with Compose. Then run:

```sh
npm create dads@latest my-app
```

Dads installs the capability packages, writes `package-lock.json`, starts
PostgreSQL, applies migrations, and waits for the web app and both APIs.
Open the printed browser URL to sign up, verify your email locally, create a
tenant, and save a protected note. The customer and staff APIs each get an
assigned loopback URL.

From `my-app`, run `npm start` to start the stack again,
`npm run dev:status` to see its URLs, and `npm run dev:down` to stop it.
If the creator reports incomplete startup after installing, resolve the
reported Docker problem and run `npm start` in the generated directory.

Commit the lockfile. The generated `ci/verify.sh` runs `npm ci` and the app's
checks. The [starter setup guide](./docs/site/guides/start.md) covers CI
templates and the first sign-in.

Each API entrypoint selects its own routes and jobs. Share a domain's services
across entrypoints and keep the composition visible in code.

```text
apps/
  customer/app.ts
  staff/app.ts
  web/
domains/
  notes/contract/
  notes/access/
  notes/server/
libraries/
assembly/
ci/
```

## Run the Workbench

Install Node 24 and start Docker with Compose. From the repository root:

```sh
npm ci
npm run workbench:dev
```

The launcher starts an isolated PostgreSQL instance, applies the Workbench
schema, and prints the HTTP API and OpenAPI URLs. In the Workbench, workspace
members can discover tasks, claim them, and read artifacts and activity.
Revoking membership removes that access.

Use [the Workbench guide](./apps/workbench/README.md) for commands, route and
access ownership, and the local identity setup.

## Work with a Dads project

The starter installs the Toolbox as a development dependency. Run these commands
from the generated app:

```sh
npx dad --help
npx dad orient domains/notes/server/routes.ts --json
npx dad doctor
npx dad test:recommend --changed --json
npx dad verify --changed --json
```

- [Generator guide](./docs/generators.md) covers all nine `dad add` commands.
- [Domain boundaries](./docs/domain-boundaries.md) explains public entrypoints and composition.
- [Toolbox command reference](./packages/foundation/toolbox/README.md) covers CLI flags and outputs.
- [CI workflow templates](./ci/README.md) run verification on another machine.
- [Doctor and enforcement](./docs/doctor.md) explain what each finding means.
- [Plugin composition](./packages/foundation/plugin/README.md) shows selective API entrypoints.
- [Contributing](./CONTRIBUTING.md) describes verification for changing the framework.

For the family history, read [Dad](./DAD.md). For the incident with the shrimp, read [Who let Gary back in?](./docs/go-ask-your-other-database.md).

Licensed under [MIT](./LICENSE.md).

See [Third-party notices](./THIRD_PARTY_NOTICES.md) for the upstream code and
licenses included with Dads.
