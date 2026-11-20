# Work with a coding agent

Give the agent a path, a concrete change, and a behavior to preserve. For
example, give this task to an agent working in a generated Dads app.

> Add pagination coverage for `GET /api/tenants/:tenantId/notes`. Read
> `AGENTS.md` and start in `domains/notes/server/routes.ts`. Create two notes in
> one workspace and verify that `perPage=1` returns one note and a total of
> two. Preserve the 404 for a signed-in user outside the tenant. Report the
> commands you ran.

Run orientation from the generated app root.

```sh
npx dad orient domains/notes/server/routes.ts --json
```

The result identifies `domains-notes` as the owner and `domains/notes` as its
root. Check `orientation.allowedDependencies` before adding an import and
follow the guide in `documentation`. Use any matching skill from the
project's `.agents/skills/`. `CLAUDE.md` imports the same `AGENTS.md`
instructions. [Agent operating model](../../agent-operating-model.md)

After the edit, inspect the change-aware plan and run the starter's checks
with Docker running.

```sh
npx dad test:recommend --changed --json
npm run verify
```

Review the [starter integration test](../../../apps/kit-workbench/tests/starter.integration.test.ts)
for both a successful read and the cross-tenant denial. Ask the agent to
identify any checks still outstanding, such as browser behavior. See
[verification](./verification.md) for the focused test command.
