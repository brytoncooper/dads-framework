# Dads agent entrypoint — active: dads-framework

Use `dads-framework` (`dads`/`dads-testing` retired). Keep changes bounded.

## Governing principle — Independent Evolution (IEP)

Things that evolve independently are owned and contracted independently; things
that change together live together (`docs/principles.md`). Similarity is not
ownership. Before adding any layer, seam, port, fake, or file, name the real
change it absorbs—if none, skip it. IEP outranks structural rules, never safety
or boundary walls.

## Workflow

1. `npx dad orient <path> --json` — find owner and workflow.
2. Load only the named skill and its links.
3. Public exports only; foreign deps stay in named integration packages.
4. `npx dad test:recommend --changed --json`, then focused checks.
5. `npx dad verify --changed --json`; report unperformed proof honestly.

## Universal rules

- No `any`, unsafe casts, or `!`; parse external values at boundaries.
- One responsibility per file; `check-source-budgets` baseline may only shrink (`docs/house-rules.md`).
- Protected operations prove denial with no relationship.
- Authz uses exported handles; wire strings stay at transport, storage, artifact, or vendor seams.
- Never weaken checks or delete failing tests.
- Resolve overlap before editing another task's files.
- Public-surface changes update package READMEs (`docs/style-guide.md`).
