# ADR-0004: Enforce Domain Boundaries and Code Health with Mechanical Gates and One-Way Ratchets

## Status

Accepted

## Date

2026-11-20

## Context

Written architecture guidelines degrade under release pressure and parallel human and AI agent edits. Manual code review misses subtle boundary leaks such as type-only cross-domain imports, vendor types emitted into `.d.ts` files, silent lint suppressions, or dropped negative type tests.

Demanding zero existing violations on day one creates the opposite failure: it blocks adoption in real repositories and forces bulk imports (such as the 2026-11-19 kit import) to weaken rules across the whole repo or disable verification.

## Decision

Enforce boundaries, type safety, and code-health ceilings through CLI gates and a one-way ratchet baseline instead of reviewer checklists.

1. **Domain and package boundaries:** Adopting applications run `npx dad check boundaries` ([domain boundaries](../domain-boundaries.md)) to isolate `domains/<domain>`, neutral `libraries/<library>`, and composition roots (`apps/*`, `assembly`). Inside the framework monorepo, [`check-dependency-boundaries.mjs`](../../scripts/checks/check-dependency-boundaries.mjs) checks imports, `package.json` manifests, and emitted `.d.ts` public surfaces against [`dads.project.json`](../../dads.project.json) and the package `kind` matrix (`core`, `adapter`, `binding`, `edge`, `profile`, `tooling`, `composition`, `artifact`).
2. **Zero-tolerance gates:** Every compiler flag in `tsconfig.base.json` (plus `check-test-types.mjs` compiling every package's `tsconfig.tests.json`), every ESLint rule in `eslint.config.js` (at `error`, zero `warn`, banning `any`, `as`, `!`, `@ts-ignore`, `@ts-nocheck`, and focused tests, with production function ceilings `complexity <= 10`, `max-depth <= 3`, `max-statements <= 20`, `max-nested-callbacks <= 2`), Rust workspace `deny`/`forbid(unsafe_code)` lints, `api-report:check`, `check-invariants.mjs`, and `check-markdown-links.mjs` fail the build on the first violation.
3. **One-way ratchets with `dad doctor --gate`:** [`dad doctor`](../doctor.md) judges 59 ceiling signals and 5 floor signals under the `standard` profile against `.agents/source-budgets.json` (invoked through `scripts/checks/check-source-budgets.mjs`). Every recorded exception requires a `reason` and explicit `--today` date. `--update` only tightens numbers (lowers ceilings, deletes cleared keys, raises floors). `--base <ref>` acts as the pawl in CI by comparing against Git history and failing any loosening, permitting floor decreases only when an entry names a `movedTo` destination that rose by at least the fall or matches an approved package retirement.
4. **Layered feedback and receipts:** Edit guards and `.githooks/pre-commit` run fast file checks (10-second target). `npm run verify` executes the parallel verification graph with content-hashed local caching and writes a proof receipt read by `.githooks/pre-push` (60-second cached target). CI and `npm run verify:release` run uncached across the full graph.

## Alternatives considered

### Rely on PR review checklists and `warn`-level lint rules

- **Pros:** Zero tooling overhead and immediate flexibility per pull request.
- **Cons:** Warnings pile up ignored, reviewers miss indirect type leaks and cross-domain imports, and AI agents receive no deterministic failure signal before committing.
- **Rejected:** Rules that depend on human memory erode on every tight deadline.

### Enforce zero exceptions with no baseline ratchet

- **Pros:** Eliminates `.agents/source-budgets.json`, `eslint-suppressions.json`, and `--base` pawl logic.
- **Cons:** Prevents existing repositories from adopting Dads one step at a time (`dad doctor --seed`) and turns large migrations into all-or-nothing rewrites.
- **Rejected:** One-way ratchets stop new regressions on day one while allowing existing debt to shrink over time.

### Gate total test counts with permanent floors

- **Pros:** Stops contributors from deleting tests to turn a failing check green.
- **Cons:** Floors on `test-count` and `doctor-cases` penalized deleting dead code and retired features.
- **Rejected (changed 2026-11-19):** `test-count` and `doctor-cases` now run report-only. Structural floors remain on `type-test-negative-cases`, `soundness-cases`, `invariants-files`, `docs-conformance-packages`, and `lint-rules`.

## Consequences

- Humans and AI agents receive deterministic pass/fail receipts with file paths, line numbers, and repair commands (`dad doctor explain <issue-id>`, `dad doctor --issue <id> --json`).
- Recorded debt moves in one direction toward each threshold; `npm run budgets:update` and `npm run lint:prune` lock in every cleanup.
- Contributors must split oversized modules rather than raising limits, record `movedTo` receipts when splitting packages, and maintain the fixture corpus under `fixtures/daddy-issues/` so every doctor signal stays regression-tested.
- `dad doctor` refuses to auto-fix structural issues because deciding where to split a file or place a boundary requires domain judgment.

## References

- [House rules](../house-rules.md)
- [Keep domains independent](../domain-boundaries.md)
- [`dad doctor` reference](../doctor.md)
- [Dads guiding principles](../principles.md)
- [Multi-API composition and CI gates guide](../site/guides/boundaries-and-apis.md)
- [Workspace boundary manifest](../../dads.project.json)
- [Dependency boundary checker](../../scripts/checks/check-dependency-boundaries.mjs)
