---
name: verify-http-work
description: Verify changed Dads work at the smallest credible scope and report proof honestly.
---

# Verify changed work

1. Run `npx dad test:recommend --changed --json`. Treat it as a candidate plan,
   not completed proof. Read the reason for every task and investigate unknown
   or unowned executable paths.
2. Run `npx dad verify --changed --json`. Report `executed`, `reused`, `failed`,
   `blocked`, and `not-applicable` separately.
3. A reused result is valid only for a supported controlled task with an exact
   local successful receipt for its captured source, tests, fixtures, config,
   dependencies, artifact, command, toolchain, and declared environment.
4. Never edit `.dads/verification` receipts. Missing or corrupt evidence means
   run again. Shell commands, live services, secrets, mutable integrations, and
   unknown inputs are run-only.
5. Use `--full` when investigating reuse or when explicit full execution is
   required. Before delivery, run the repository's complete verification and
   packed-consumer proof for changed public packages.

Focused proof does not replace conformance, integration, composition, denial,
or deployment proof that the change requires. Provider failure blocks consumer
credit even when an old artifact exists. State all unperformed checks honestly.
