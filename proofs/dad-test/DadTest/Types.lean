namespace DadTest

abbrev ModuleId := String
abbrev Symbol := String
abbrev ProjectId := String
abbrev TaskId := String

/--
Observation channel for a task or reachability walk:
- `runtime`: runtime test suites (e.g. Vitest); pure `import type` edges are erased
  when `erasesTypeOnly = true` (`verbatimModuleSyntax` / `isolatedModules`).
- `typecheck`: typecheck suites (e.g. `tsc --noEmit`); observes both runtime and
  `import type` edges with exact named symbol precision.
-/
inductive AnalysisChannel where
  | runtime
  | typecheck
  deriving DecidableEq, Repr

/-- How an import edge connects `source` (the importer) to `target` (the imported module). -/
inductive ImportKind where
  /-- Named runtime import (`import { a, b } from "./target"`). -/
  | namedRuntime (requested : List Symbol)
  /-- Bare side-effect runtime import (`import "./target"`). -/
  | bareRuntime
  /-- Star re-export (`export * from "./target"`), forwarding every symbol except `"default"`. -/
  | reexportAll
  /--
  Namespace import whose member accesses are statically bounded (`import * as ns; ns.a; ns.b`)
  and `ns` never escapes as a whole object or dynamic index. Exact equivalent of named imports.
  -/
  | namespaceTracked (members : List Symbol)
  /-- Escaped namespace import (`Object.keys(ns)`, `{ ...ns }`, `ns[k]`, passed as value). -/
  | namespaceEscaped
  /-- Type-only import (`import type { A, B } from "./target"`). -/
  | typeOnly (requested : List Symbol)
  /--
  Statically bounded dynamic import (e.g. `import(\`./handlers/${k}.js\`)` matched against a
  finite resolved target set). Treated as an exact runtime dependency on this target without
  widening to the whole workspace.
  -/
  | boundedDynamic
  deriving DecidableEq, Repr

/-- True for every edge that evaluates `target` at runtime (every edge except `import type`). -/
def ImportKind.isRuntime : ImportKind → Bool
  | .typeOnly _ => false
  | _ => true

structure ImportEdge where
  source : ModuleId
  target : ModuleId
  kind : ImportKind
  deriving DecidableEq, Repr

/--
AST-normalized change evidence for a modified module:
- `complete = false`: an unattributed diff hunk exists; widens conservatively.
- `complete = true, semanticChange = false`: comment/whitespace/formatting-only change;
  no runtime or type behavior changed, so zero tests need to run.
- `complete = true, semanticChange = true`: AST changed; module itself is impacted,
  `exports` lists the exact exported symbols whose AST changed, and `moduleEvalChanged`
  is true whenever top-level module-evaluation behavior changed (effectful initializer,
  top-level statement, impure class static block, private helper called by an effectful
  node, or runtime import specifier graph change).
-/
structure ChangeEvidence where
  complete : Bool
  semanticChange : Bool
  exports : List Symbol
  moduleEvalChanged : Bool := false
  deriving DecidableEq, Repr

inductive UncertaintyScope where
  | wholeWorkspace
  | reachedModule
  deriving DecidableEq, Repr

structure GraphUncertainty where
  path : ModuleId
  code : String
  scope : UncertaintyScope
  deriving DecidableEq, Repr

/-- Abstract dependency graph over arbitrary finite module & symbol spaces. -/
structure DepGraph where
  modules : List ModuleId
  edges : List ImportEdge
  /--
  Intra-file symbol-level dependency projection:
  `affectedOwnExports src tgt importedSym` returns the exact own exports of `src` that
  transitively depend on `(tgt, importedSym)` (or all own exports of `src` if `src` has
  top-level side effects / coarse analysis).
  -/
  affectedOwnExports : ModuleId → ModuleId → Symbol → List Symbol
  /-- Own exports of `src` affected when `src` has a bare side-effect or dynamic import. -/
  allOwnExports : ModuleId → List Symbol
  /-- Whether TypeScript erases `import type` edges at runtime (`verbatimModuleSyntax`). -/
  erasesTypeOnly : Bool
  changeOf : ModuleId → Option ChangeEvidence
  declaredUncertainties : List GraphUncertainty

inductive ImpactMode where
  | always
  | changedFiles (ownedPaths : List ModuleId)
  | project
  | reachability
  deriving DecidableEq, Repr

structure TaskSpec where
  id : TaskId
  project : ProjectId
  impact : ImpactMode
  channel : AnalysisChannel
  testFiles : List ModuleId
  /-- Declared non-JS asset inputs (e.g. `.sql` migrations, JSON fixtures) scoped to this task. -/
  assetPaths : List ModuleId
  dependsOn : List TaskId
  deriving DecidableEq, Repr

structure Manifest where
  projects : List ProjectId
  ownerOf : ModuleId → Option ProjectId
  /-- `fallbackDeps p` lists the projects that `p` depends on (mirroring `fallback_dependencies`). -/
  fallbackDeps : ProjectId → List ProjectId
  tasks : List TaskSpec

/-- How a planned task should execute, supporting sound & exact file-level test narrowing. -/
inductive TaskExecutionScope where
  /-- Proven unaffected: safe to skip. -/
  | skipProvenUnaffected
  /-- Un-widened reachability task: safe to run only the exact reached test files. -/
  | subset (files : List ModuleId)
  /-- Widened, non-reachability, un-enumerated, or full-fallback task: must run all tests. -/
  | allTests
  deriving DecidableEq, Repr

end DadTest
