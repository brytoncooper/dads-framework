# `create-dads`

Create a Postgres-backed TypeScript API with email sign-in, tenants,
relationship-guarded notes, and named customer and staff entrypoints.

## What Dad does for you

Dads writes the starter files, installs the Dads capability packages and
records their versions in `package-lock.json`. The creator starts the local
Docker stack and prints its healthy web and API URLs. An identical rerun
keeps the project files and resumes the stack.

## Try it

Use Node 24 with Docker running and the Compose plugin available. Run the
creator from a parent directory:

```sh
npm create dads@0.6.3 my-app
cd my-app
```

To start without the notes domain, staff impersonation, or example walkthroughs,
pass `--template minimal`:

```sh
npm create dads@0.6.3 my-app -- --template minimal
cd my-app
```

The creator installs dependencies, waits for the Docker stack to become
healthy, and prints the web URL. Open that URL to reach the sign-in screen.
From the generated directory,
`npm start` starts the stack again, `npm run dev:status` shows its state,
and `npm run dev:down` stops it. Read the [documentation](../../../docs/site/guides/index.md)
to read a verification email from the local mailbox, sign in, and save a note.
For a separate API host, use `npm run start:api` and the environment in the
generated deployment guide. Run `npm run verify` from the app root with Docker
running for the live PostgreSQL checks.
Commit the generated `package-lock.json`. The `ci/verify.sh` command runs
`npm ci` before verification, and `ci/` contains templates for CI providers.

The generated project includes [`package.json`](../../../apps/kit-workbench/package.json) for its launch commands
and [`assembly/compose.yml`](../../../apps/kit-workbench/assembly/compose.yml) for the local services those commands start.
The links open the starter source in this repo.

## Commands

- `--template <minimal|example>` chooses the project template. `example` (the default) includes the notes domain, permissions dashboard, and walkthroughs. `minimal` keeps the full framework layout (Compose stack, PostgreSQL migrations, Better Auth identity, tenants, named customer and staff APIs, and the React workspace shell) with no example domains.
- `--name <name>` sets the npm package name.
- `--existing` creates an isolated project under the target's `dads/` folder.
- `--dry-run` lists files without writing them.
- `--skip-install` writes files and leaves dependency installation and startup to your own tooling.
- `--skip-doctor` skips the initial report on an existing project.
- `--today YYYY-MM-DD` supplies a date to the initial Doctor report.
- `--json` prints one machine-readable result.
- `-h`, `--help` prints command usage and options.

The Doctor report runs before writes when the target already contains a
project. It can surface adoption issues without changing the project. Existing-project mode leaves local startup to the adopter.

If Docker startup fails, the creator exits nonzero and keeps installed files
and the lockfile. Once Docker is available, run `npm start` from the generated
project.

## What it refuses to do

The creator rejects unknown options and reports a conflict when an owned file
has changed. Use the isolated `--existing` mode to keep an existing application
intact.

## Verification

```sh
npm test -w create-dads
```

The packed adoption proof installs the generated app from local tarballs
and runs its provider-neutral CI command against a disposable PostgreSQL
database.
