# Dads

**A sensible framework with firm boundaries.**

Dads is a TypeScript backend framework for building strongly typed APIs.
A route declares what it accepts, what it returns, who can call it, and which
rate limits apply. Dads validates requests and generates OpenAPI documentation
from those contracts. Your typed clients can use the same schemas, and your
application logic stays plain TypeScript.

## Start your own app

Use Node 24, npm, and Docker with Compose v2. Start Docker and run the
0.3.0 creator from the parent directory for your new project.

```sh
npm create dads@0.3.0 my-app
```

The creator installs dependencies, starts PostgreSQL, applies migrations,
and prints URLs for the browser app and both APIs. Open the browser URL.
The [Quickstart](./docs/site/guides/quickstart.md) walks through local email
verification and saving a protected note. From the generated directory,
`npm start` starts the stack again and `npm run dev:down` stops it.

If `create-dads@0.3.0` is unavailable from your npm registry, use the
[reference Workbench below](#run-the-workbench) to try Dads from
source. For a project you already run, see
[adopt one capability](./docs/site/guides/adopt.md).
Browse the [package examples](https://dadsframework.dev/docs/packages) for install commands, working code, and expected results.

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

This repository's Workbench is a task API. The launcher starts an isolated
PostgreSQL instance, applies the schema, and prints the API and OpenAPI URLs.
Workspace members can discover tasks, claim them, and read artifacts and
activity. Revoking membership removes that access.

Run `npm run workbench:stop` to stop it. Use the
[Workbench guide](./apps/workbench/README.md) for the local identity setup
and route ownership.

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
- [Connect a company directory](./docs/site/guides/company-access.md) walks through enterprise sign-in, provisioning, and auditing access.
- [Toolbox command reference](./packages/foundation/toolbox/README.md) covers CLI flags and outputs.
- [CI workflow templates](./ci/README.md) run verification on another machine.
- [Doctor and enforcement](./docs/doctor.md) explain what each finding means.
- [Plugin composition](./packages/foundation/plugin/README.md) shows selective API entrypoints.
- [Contributing](./CONTRIBUTING.md) describes verification for changing the framework.

Read [Why Dads](./docs/site/guides/start.md) for the design tradeoffs, or
[Dad](./DAD.md) and [Who let Gary back in?](./docs/go-ask-your-other-database.md)
for the stories behind them.

Licensed under [MIT](./LICENSE.md).

See [Third-party notices](./THIRD_PARTY_NOTICES.md) for the upstream code and
licenses included with Dads.

The [website source and build instructions](./website/README.md) are included in this repository.
