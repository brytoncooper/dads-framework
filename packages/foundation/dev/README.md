# `@dads-framework/dev`

Run several development checkouts side by side. Each Git worktree gets its own loopback ports, Postgres database, and file root.

## Try it

In a Git checkout, install the runner and make sure `psql` is available.
The example assumes the application has a `dev` script that starts an HTTP
service on the supplied `HOST` and `PORT` with a `/health` endpoint. The
`migrate` script must use the supplied `DATABASE_URL`.

```sh
npm install --save-dev @dads-framework/dev
```

Save this as `dads.dev.json` in the application root.

```json
{
  "prepare": ["npm", "run", "migrate"],
  "services": [
    {
      "name": "api",
      "command": ["npm", "run", "dev"],
      "portOffset": 0,
      "readyPath": "/health"
    }
  ]
}
```

Export `DADS_DEV_POSTGRES_URL` with the URL of a loopback Postgres
maintenance database. The role needs permission to create databases. Run
these commands from the configured checkout.

```sh
npx dad-dev ready
npx dad-dev up
npx dad-dev status
npx dad-dev down
```

`up` waits for `/health` before returning. `status` lists the service URL,
database, and file root for the checkout. A second configured worktree gets
its own values. Restarting the same checkout after `down` reuses its
database and files.

To check isolation, run `dad-dev status` after both worktrees are up. The
slot records should show distinct API URLs, Postgres databases, and file
roots. A stop and restart in one worktree should leave the other running.

The repo-only [`proof/dads.dev.json`](proof/dads.dev.json) runs two services using
[`proof/service.mjs`](proof/service.mjs). [`proof/verify-slots.sh`](proof/verify-slots.sh) exercises
that configuration in separate worktrees.

## Commands

| Invocation                            | Behavior                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dad-dev ready`                       | Assigns the slot, prepares Postgres and file storage, writes the environment file, and runs `npm ci` in the checkout if it has a lockfile.                 |
| `dad-dev up`                          | Prepares the slot, runs optional `prepare`, starts the services, and waits for their HTTP readiness checks.                                                |
| `dad-dev status`                      | Lists slots and service URLs across this repository's checkouts.                                                                                           |
| `dad-dev down`                        | Asks the slot supervisor to stop and retains the slot's data for restart.                                                                                  |
| `dad-dev scratch -- <command> [args]` | Runs a command in a detached checkout at the current commit. Removes a clean, idle scratch checkout and keeps one with local changes or running processes. |
| `dad-dev sweep [--base <ref>]`        | Reports candidates for worktree cleanup. The default base is `origin/main`.                                                                                |
| `dad-dev prune [--base <ref>]`        | Rechecks and removes eligible worktrees using Git's ordinary removal command.                                                                              |

## Contract

The runner supplies `HOST`, `PORT`, `DATABASE_URL`, and `DADS_FILE_ROOT`. Each service may supply extra `env` variables. Default blocks contain ten ports, beginning at 4300, with up to 32 slots. Configure `basePort`, `portsPerSlot`, and `maxSlots` in the application file.

Git worktrees share the registry under their common Git directory. Supervisor logs and settings stay there. `sweep` and `prune` protect the current and primary checkouts, locked and dirty worktrees, visible same-user processes using the checkout and all managed slot supervisors, and commits absent from locally known remote refs. They recognize equivalent commits through `git cherry` and apply a sixty-minute grace period to worktrees without unique commits. They leave branches and slot databases intact.

Run `bash packages/foundation/dev/proof/verify-slots.sh` after building the workspace for an isolated Linux proof with Docker, Git, and Postgres.
