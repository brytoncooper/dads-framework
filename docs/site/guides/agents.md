# Work with a coding agent

Read the repository's `AGENTS.md` before editing. In a generated app, use
the shared `AGENTS.md` instructions and the skills the starter writes
alongside its code. `CLAUDE.md` imports that same file.

Run `dad orient <path> --json` for the owner, permitted dependencies,
applicable skills, and suggested verification. Read
[the agent operating model](../../agent-operating-model.md) for the limits on
cross-package changes. The JSON output includes a path to the owning guide. Use `dad doctor explain <issue-id>` and the
[Doctor reference](../../doctor.md) to turn a diagnostic into a repair plan.

For a route or migration, follow the owning package's README and the
[guarded resource example](./guarded-resource.md) or
[migration guide](./audit-migrations.md). Use the Markdown source link on each
page or the site's `llms.txt` when loading the docs into another tool.

Report which checks ran and where they ran. State any cases that still need
a database, browser, or deployment environment.
