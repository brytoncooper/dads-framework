# `@dads-framework/dev`

Run several development checkouts side by side. Each Git worktree gets its own loopback ports, Postgres database, and file root.

## Try it

Add `dads.dev.json` at the root of the application. List each service's command, port offset, and HTTP readiness path. Commands are executable arguments.

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

Set `DADS_DEV_POSTGRES_URL` to a loopback Postgres maintenance database. Its role needs permission to create databases. Install `psql` locally, then run `dad-dev ready` and `dad-dev up` in both checkouts. `dad-dev status` shows the local URLs, database names, and paths to owner-only settings files and file roots. `dad-dev down` stops the current checkout. A restart reuses its database and files.

## Commands

| Command                               | Behavior                                                                                                                                                   |
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
