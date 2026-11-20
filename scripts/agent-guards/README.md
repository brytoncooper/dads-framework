# Agent guards

Three hooks that hold the house rules while an agent is working, wired into
Claude Code (`.claude/settings.json`) and Cursor (`.cursor/hooks.json`). They
are the fastest of the three speeds: edit time, then commit time
(`.githooks/`), then CI (`.github/workflows/verify.yml`). Each one reads a
hook event as JSON on stdin and answers with JSON on stdout.

| Guard                       | Fires on                     | Answer                                                                                                                                                                       |
| --------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guard-protected-files.mjs` | an edit to any file          | `ask` when the path is one the user owns: lint and compiler config, the ratchet baseline, the hooks, the guards, the workflow, `AGENTS.md`, `LICENSE.md`                     |
| `guard-shell-commands.mjs`  | a shell command              | `deny` for `--no-verify`, a force-push of main, a deletion of main, or a push of main from another branch; `ask` for `gh api` calls that touch rulesets or branch protection |
| `check-after-edit.mjs`      | a file that was just written | runs the mechanical fixes (`eslint --fix`, `rustfmt`, `prettier --write`) and the ratchet, then blocks with whatever is left                                                 |

Two rules decide what happens when something goes wrong. A missing tool
**fails open**: an unbootstrapped checkout must not wedge every edit, and the
git hooks and CI are still the wall. Unreadable hook input **fails closed**:
a guard that cannot see what it is being asked about does not wave it
through.

Every guard proves itself against a seeded matrix, with no repository and no
network involved:

```sh
node scripts/agent-guards/guard-protected-files.mjs --self-test
node scripts/agent-guards/guard-shell-commands.mjs --self-test
node scripts/agent-guards/check-after-edit.mjs --self-test
```

Run the self-tests from the repository root after editing a guard. Each
command prints its case count and exits successfully when the matrix passes.
The [house rules](../../docs/house-rules.md) define the checks these hooks apply.
