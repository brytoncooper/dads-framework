# Adopt one capability

Choose this path when an existing application already works and you want
one narrower guarantee before adopting more. For a service with unclear
request validation, start with one route and write a test for the malformed
payload you want to reject. Keep serving the rest of the application as before.

If the [toolbox](../../../packages/foundation/toolbox/README.md) is installed
in the existing repository, run `npx dad doctor` to see its current findings.
Use `dad doctor explain <issue-id>` to get the rule and the repair it expects.
See the [Doctor command reference](../../doctor.md) for profiles and reports.

Choose one change with a clear test: validate a boundary, generate a client,
or lock the existing code-health baseline. Keep the original app running and
prove the new capability before routing production inputs to it.

Use the creator's [existing-project mode](../../../packages/foundation/create-dads/README.md#commands)
to place a separate starter under the target's `dads/` directory. Preview it
with `npm create dads@latest /path/to/your/project -- --existing --dry-run`.
Remove `--dry-run` to write the files and install the starter's dependencies.
Your existing project keeps its package manifest and runtime. Start Docker,
then run `npm start` from the new `dads/` directory. Open the web URL shown
when the starter is ready. The [quickstart](./quickstart.md) walks through
the sign-in and note flow in that starter.

Commit the isolated starter's lockfile if you use its CI. Its generated
`ci/verify.sh` runs `npm ci` before verification.

Use [the adoption model](../../adoption-model.md)
to decide when to bring a capability into the host project, and
[dependency libraries](../../dependency-libraries.md) for a bounded integration.
