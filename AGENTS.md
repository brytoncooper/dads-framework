# Dads agent entrypoint — active: dads-framework

Use `dads-framework`; `dads` and `dads-testing` are retired.
Keep changes bounded; load only the owning workflow.

1. Run `npx dad orient <path> --json` to find the owner and relevant
   workflow.
2. Load only the named skill and references it links.
3. Use public package exports; foreign dependencies stay inside their named
   integration package.
4. Run `npx dad test:recommend --changed --json`, then the recommended
   focused checks.
5. Finish with `npx dad verify --changed --json` and report unperformed
   proof honestly.

Universal rules:

- Never introduce `any`, unsafe assertions, or non-null assertions.
- External values are parsed at their boundary.
- Every abstraction names the change it absorbs.
- One responsibility per file; `check-source-budgets` is the ceiling and
  the baseline may only shrink (docs/house-rules.md).
- Every protected operation proves denial when no relationship exists.
- Authorization code uses exported kind, relation, and permission handles;
  repeated wire strings stay at transport, storage, artifact, or vendor seams.
- Never weaken a check or delete a failing test to get green.
- Never edit another task's owned files without resolving the overlap.
- Docs are part of done: a public-surface change updates its package README
  in the two-register style (docs/style-guide.md).
