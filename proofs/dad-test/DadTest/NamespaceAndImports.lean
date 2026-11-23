import DadTest.Types
import DadTest.Reachability
import DadTest.Planner
import DadTest.PrivateHelper

namespace DadTest

/-!
# Part A — `export * as ns from "./target"` Namespace Re-Export Soundness & Exactness

A barrel module can re-export all runtime exports of `target` as a namespace object via
`export * as ns from "./target"`. Downstream importers that import `ns` from the barrel either:
- project statically bounded members (`ns.m1`, `ns.m2`, ...) without escaping `ns` -> affected
  if and only if at least one of those projected members changed in `target`, OR
- escape `ns` as a whole object (`Object.keys(ns)`, `{ ...ns }`, `ns[k]`, passed as an argument) ->
  conservatively affected whenever ANY runtime export of `target` changed.

Note: unlike `export * from "./target"` (which excludes `"default"`), ESM's
`export * as ns from "./target"` binds a Module Namespace Exotic Object that includes every
runtime export of `target` (including `"default"` as `ns.default`).
-/

/-- How a downstream module uses an imported namespace `ns` originating from a barrel re-export. -/
inductive NamespaceUse where
  /-- Downstream only reads statically bounded members `ns.m1`, `ns.m2`, ... and never escapes `ns`. -/
  | trackedMembers (members : List Symbol)
  /-- Downstream escapes `ns` (`Object.keys(ns)`, spread, dynamic index, passed as value). -/
  | escaped
  deriving DecidableEq, Repr

/-- A barrel re-export edge representing `export * as ns from "./target"` inside `barrel`. -/
structure NamespaceReexportEdge where
  barrel : ModuleId
  ns : Symbol
  target : ModuleId
  deriving DecidableEq, Repr

/-- A downstream module importing `ns` from `barrel` with bounded member accesses or escaped use. -/
structure DownstreamNsImport where
  downstream : ModuleId
  barrel : ModuleId
  ns : Symbol
  use : NamespaceUse
  deriving DecidableEq, Repr

/-- Graph of barrel namespace re-exports, downstream namespace imports, and changed target exports. -/
structure NamespaceReexportGraph where
  reexports : List NamespaceReexportEdge
  downstreamImports : List DownstreamNsImport
  /-- Runtime exports of a target module that changed in the diff. -/
  changedExports : ModuleId → List Symbol

/--
Ground-truth semantic relation: downstream module `d` may observe a runtime change through a
barrel `export * as ns from "./target"` iff there exist a barrel re-export `r`, a matching
downstream import `imp` of `(r.barrel, r.ns)` by `d`, and a changed runtime export
`s ∈ g.changedExports r.target` that is either read via `trackedMembers` or observable via
escaped `ns`.
-/
def DownstreamAffectedByNsReexport (g : NamespaceReexportGraph) (d : ModuleId) : Prop :=
  ∃ r ∈ g.reexports, ∃ imp ∈ g.downstreamImports,
    imp.downstream = d ∧ imp.barrel = r.barrel ∧ imp.ns = r.ns ∧
    ∃ s ∈ g.changedExports r.target,
      match imp.use with
      | .trackedMembers members => s ∈ members
      | .escaped => True

/-- Executable check: whether a downstream namespace import is affected by any barrel re-export. -/
def nsImportTriggered (g : NamespaceReexportGraph) (imp : DownstreamNsImport) : Bool :=
  g.reexports.any fun r =>
    r.barrel == imp.barrel && r.ns == imp.ns &&
    match imp.use with
    | .trackedMembers members => (g.changedExports r.target).any (fun s => members.contains s)
    | .escaped => !(g.changedExports r.target).isEmpty

/-- Executable selection of all downstream modules affected through namespace re-exports. -/
def selectDownstreamNs (g : NamespaceReexportGraph) : List ModuleId :=
  g.downstreamImports.filterMap fun imp =>
    if nsImportTriggered g imp then some imp.downstream else none

private theorem isEmpty_eq_false_iff_exists_mem {α : Type} (xs : List α) :
    xs.isEmpty = false ↔ ∃ x, x ∈ xs := by
  cases xs with
  | nil => simp
  | cons x _ => exact ⟨fun _ => ⟨x, List.mem_cons_self ..⟩, fun _ => rfl⟩

/--
**Theorem 1 (Namespace Re-Export Tracked Member Soundness):**
If a runtime export `s` changed in `target`, `barrel` has `export * as ns from target`, and
downstream `d` imports `ns` from `barrel` with tracked member read `ns.s`, then `d` is selected.
-/
theorem ns_reexport_member_sound
    (g : NamespaceReexportGraph)
    {r : NamespaceReexportEdge} {imp : DownstreamNsImport}
    {d : ModuleId} {members : List Symbol} {s : Symbol}
    (hr : r ∈ g.reexports)
    (himp : imp ∈ g.downstreamImports)
    (hd : imp.downstream = d)
    (hbarrel : imp.barrel = r.barrel)
    (hns : imp.ns = r.ns)
    (huse : imp.use = .trackedMembers members)
    (hchanged : s ∈ g.changedExports r.target)
    (hread : s ∈ members) :
    d ∈ selectDownstreamNs g := by
  unfold selectDownstreamNs
  rw [List.mem_filterMap]
  refine ⟨imp, himp, ?_⟩
  have htrig : nsImportTriggered g imp = true := by
    unfold nsImportTriggered
    rw [List.any_eq_true]
    refine ⟨r, hr, ?_⟩
    simp only [hbarrel, hns, huse, beq_self_eq_true, Bool.true_and]
    exact List.any_eq_true.mpr ⟨s, hchanged, List.contains_iff_mem.mpr hread⟩
  simp [htrig, hd]

/--
**Theorem 2 (Namespace Re-Export Escape Widening):**
If ANY runtime export `s` changed in `target`, `barrel` has `export * as ns from target`, and
downstream `d` imports `ns` from `barrel` and escapes `ns`, then `d` is conservatively selected.
-/
theorem ns_reexport_escape_widens
    (g : NamespaceReexportGraph)
    {r : NamespaceReexportEdge} {imp : DownstreamNsImport}
    {d : ModuleId} {s : Symbol}
    (hr : r ∈ g.reexports)
    (himp : imp ∈ g.downstreamImports)
    (hd : imp.downstream = d)
    (hbarrel : imp.barrel = r.barrel)
    (hns : imp.ns = r.ns)
    (huse : imp.use = .escaped)
    (hchanged : s ∈ g.changedExports r.target) :
    d ∈ selectDownstreamNs g := by
  unfold selectDownstreamNs
  rw [List.mem_filterMap]
  refine ⟨imp, himp, ?_⟩
  have hnonempty : (g.changedExports r.target).isEmpty = false :=
    (isEmpty_eq_false_iff_exists_mem _).mpr ⟨s, hchanged⟩
  have htrig : nsImportTriggered g imp = true := by
    unfold nsImportTriggered
    rw [List.any_eq_true]
    refine ⟨r, hr, ?_⟩
    simp [hbarrel, hns, huse, hnonempty]
  simp [htrig, hd]

/--
**Theorem 3 (Namespace Re-Export Exact `↔` Characterization):**
Downstream module `d` is selected by `selectDownstreamNs g` if and only if
`DownstreamAffectedByNsReexport g d` holds. In particular, disjoint tracked member reads
(`ns.other`) are NEVER spuriously selected when `ns` does not escape.
-/
theorem ns_reexport_exact_iff (g : NamespaceReexportGraph) (d : ModuleId) :
    d ∈ selectDownstreamNs g ↔ DownstreamAffectedByNsReexport g d := by
  constructor
  · intro hsel
    unfold selectDownstreamNs at hsel
    rw [List.mem_filterMap] at hsel
    rcases hsel with ⟨imp, himp, hmatch⟩
    cases htrig : nsImportTriggered g imp with
    | false => simp [htrig] at hmatch
    | true =>
      simp only [htrig, ↓reduceIte, Option.some.injEq] at hmatch
      unfold nsImportTriggered at htrig
      rw [List.any_eq_true] at htrig
      rcases htrig with ⟨r, hr, hrcond⟩
      simp only [Bool.and_eq_true, beq_iff_eq] at hrcond
      rcases hrcond with ⟨⟨hbarrel, hns⟩, huseCond⟩
      cases huse : imp.use with
      | trackedMembers members =>
        rw [huse] at huseCond
        rcases List.any_eq_true.mp huseCond with ⟨s, hsChanged, hsMem⟩
        refine ⟨r, hr, imp, himp, hmatch, hbarrel.symm, hns.symm, s, hsChanged, ?_⟩
        rw [huse]
        exact List.contains_iff_mem.mp hsMem
      | escaped =>
        rw [huse] at huseCond
        have hnonempty : (g.changedExports r.target).isEmpty = false := by
          simpa using huseCond
        rcases (isEmpty_eq_false_iff_exists_mem _).mp hnonempty with ⟨s, hsChanged⟩
        refine ⟨r, hr, imp, himp, hmatch, hbarrel.symm, hns.symm, s, hsChanged, ?_⟩
        rw [huse]
        trivial
  · rintro ⟨r, hr, imp, himp, hd, hbarrel, hns, s, hsChanged, hobs⟩
    cases huse : imp.use with
    | trackedMembers members =>
      rw [huse] at hobs
      exact ns_reexport_member_sound g hr himp hd hbarrel hns huse hsChanged hobs
    | escaped =>
      exact ns_reexport_escape_widens g hr himp hd hbarrel hns huse hsChanged

/-- Corollary: a downstream module with only disjoint tracked member reads is never selected. -/
theorem ns_reexport_disjoint_not_selected (g : NamespaceReexportGraph) (d : ModuleId)
    (hdisjoint : ∀ imp ∈ g.downstreamImports, imp.downstream = d →
      ∃ members, imp.use = .trackedMembers members ∧
        ∀ r ∈ g.reexports, imp.barrel = r.barrel → imp.ns = r.ns →
          ∀ s ∈ g.changedExports r.target, s ∉ members) :
    d ∉ selectDownstreamNs g := by
  intro hsel
  rcases (ns_reexport_exact_iff g d).mp hsel with ⟨r, hr, imp, himp, hd, hbarrel, hns, s, hsChanged, hobs⟩
  rcases hdisjoint imp himp hd with ⟨members, huse, hnotmem⟩
  rw [huse] at hobs
  exact hnotmem r hr hbarrel hns s hsChanged hobs

/-!
# Part B — Import-Line Edit & Newly-Added Pure Module Attribution

## B.1 — Import-Line Edit Attribution
In a module with pure top-level statements (`isPureTopLevel = true`), editing an import binding `b`
(adding, removing, or modifying `import { b } from ...`, `import b from ...`, or `import * as b`)
can only affect exported declarations that transitively reference `b` through the intra-file
def-use graph (`UsesStar` from `PrivateHelper.lean`). By contrast, a bare side-effect import
(`import "./polyfill"`) or an impure top-level module widens conservatively to ALL exports.
-/

/-- Identifier for a local import binding inside a module. -/
abbrev BindingId := String

/-- Classification of a changed import line in a module diff. -/
inductive ImportLineEdit where
  /-- Added, removed, or modified a bound import (`import { b }`, `import b`, `import * as b`). -/
  | binding (b : BindingId)
  /-- Added, removed, or modified a bare side-effect import (`import "./polyfill"`). -/
  | bareSideEffect
  deriving DecidableEq, Repr

/-- Intra-file def-use representation of a module with import-binding references and edits. -/
structure ImportModuleIR where
  /-- True iff every top-level statement in this module is side-effect-free. -/
  isPureTopLevel : Bool
  /-- All top-level declarations (both exported and non-exported private helpers). -/
  decls : List DeclId
  /-- Exported public name bound to a declaration (`none` for private helpers). -/
  exportedName : DeclId → Option Symbol
  /-- Intra-file def-use: `uses caller` lists declarations referenced in `caller`'s body. -/
  uses : DeclId → List DeclId
  /-- Direct import bindings referenced in a declaration's body. -/
  importRefs : DeclId → List BindingId
  /-- Import-line edits observed in this module's diff. -/
  importEdits : List ImportLineEdit

/-- All declared exported symbols of an `ImportModuleIR`. -/
def allImportModuleExports (m : ImportModuleIR) : List Symbol :=
  m.decls.filterMap m.exportedName

/-- Bound import identifiers extracted from `m.importEdits`. -/
def changedImportBindings (m : ImportModuleIR) : List BindingId :=
  m.importEdits.filterMap fun e =>
    match e with
    | .binding b => some b
    | .bareSideEffect => none

/--
Project `ImportModuleIR` onto `PrivateHelper.ModuleIR` by seeding each declaration in `m.decls`
that directly references a changed import binding.
-/
def toImportSeedModuleIR (m : ImportModuleIR) : ModuleIR :=
  let changed := changedImportBindings m
  let seeded := m.decls.filter fun d =>
    (m.importRefs d).any fun b => changed.contains b
  { isPureTopLevel := m.isPureTopLevel
    decls := m.decls
    exportedName := m.exportedName
    uses := m.uses
    hunks := seeded.map HunkAttribution.inDecl }

/--
Ground-truth semantic relation for pure import-line edits:
an exported symbol `sym` may observe a changed import binding iff some exported declaration `e`
bound to `sym` transitively uses a declaration `d ∈ m.decls` that directly references a changed
import binding `b`.
-/
def ExportMayObserveImportEdit (m : ImportModuleIR) (sym : Symbol) : Prop :=
  ∃ e ∈ m.decls, m.exportedName e = some sym ∧
    ∃ d ∈ m.decls, UsesStar m.uses e d ∧
      ∃ b ∈ m.importRefs d, ImportLineEdit.binding b ∈ m.importEdits

/--
Executable import-line edit attribution:
- No import edits -> no semantic change (`complete = true, semanticChange = false, exports = []`).
- Impure top-level module OR any bare side-effect import (`import "./x"`) -> widens conservatively
  (`complete = false, semanticChange = true, exports = allImportModuleExports m`).
- Pure top-level module with binding-only edits -> exact reverse def-use closure over declarations
  referencing changed bindings (`complete = true`), delegating to `attributeModuleHunks`.
-/
def attributeImportLineEdits (m : ImportModuleIR) : ChangeEvidence :=
  if m.importEdits.isEmpty then
    { complete := true, semanticChange := false, exports := [] }
  else if !m.isPureTopLevel || m.importEdits.contains .bareSideEffect then
    { complete := false, semanticChange := true, exports := allImportModuleExports m }
  else
    let res := attributeModuleHunks (toImportSeedModuleIR m)
    { complete := true, semanticChange := true, exports := res.exports }

private theorem mem_changedImportBindings_iff (m : ImportModuleIR) (b : BindingId) :
    b ∈ changedImportBindings m ↔ ImportLineEdit.binding b ∈ m.importEdits := by
  unfold changedImportBindings
  rw [List.mem_filterMap]
  constructor
  · rintro ⟨e, he, hmatch⟩
    cases e with
    | bareSideEffect => simp at hmatch
    | binding b' =>
      simp only [Option.some.injEq] at hmatch
      subst hmatch
      exact he
  · intro hb
    exact ⟨.binding b, hb, rfl⟩

private theorem allHunksInKnownDecls_toImportSeed (m : ImportModuleIR) :
    allHunksInKnownDecls (toImportSeedModuleIR m) = true := by
  unfold allHunksInKnownDecls toImportSeedModuleIR
  rw [List.all_eq_true]
  intro h hh
  rcases List.mem_map.mp hh with ⟨d, hd, rfl⟩
  exact List.contains_iff_mem.mpr (List.mem_filter.mp hd).1

private theorem exportMayObserveHunk_toImportSeed_iff (m : ImportModuleIR) (sym : Symbol) :
    ExportMayObserveHunk (toImportSeedModuleIR m) sym ↔ ExportMayObserveImportEdit m sym := by
  unfold ExportMayObserveHunk ExportMayObserveImportEdit toImportSeedModuleIR
  dsimp only
  constructor
  · rintro ⟨e, he, hexp, d, hd, hhunk, hpath⟩
    rcases List.mem_map.mp hhunk with ⟨d', hd', hEq⟩
    injection hEq with hdEq
    subst d'
    rcases List.mem_filter.mp hd' with ⟨_, hrefs⟩
    rcases List.any_eq_true.mp hrefs with ⟨b, hbRef, hbCh⟩
    exact ⟨e, he, hexp, d, hd, hpath, b, hbRef,
      (mem_changedImportBindings_iff m b).mp (List.contains_iff_mem.mp hbCh)⟩
  · rintro ⟨e, he, hexp, d, hd, hpath, b, hbRef, hbEdit⟩
    refine ⟨e, he, hexp, d, hd, ?_, hpath⟩
    apply List.mem_map.mpr
    refine ⟨d, List.mem_filter.mpr ⟨hd, ?_⟩, rfl⟩
    exact List.any_eq_true.mpr
      ⟨b, hbRef, List.contains_iff_mem.mpr ((mem_changedImportBindings_iff m b).mpr hbEdit)⟩

/--
**Theorem 4 (Import-Line Edit Soundness):**
In any well-formed pure top-level module with no bare side-effect import edits, EVERY exported
symbol `sym` that transitively references a changed import binding `b` is attributed in
`(attributeImportLineEdits m).exports`.
-/
theorem import_line_edit_sound (m : ImportModuleIR)
    (hwf : ∀ a ∈ m.decls, ∀ b ∈ m.uses a, b ∈ m.decls)
    (hpure : m.isPureTopLevel = true)
    (hnobare : ImportLineEdit.bareSideEffect ∉ m.importEdits)
    (sym : Symbol)
    (hobs : ExportMayObserveImportEdit m sym) :
    sym ∈ (attributeImportLineEdits m).exports := by
  have hnonempty : m.importEdits.isEmpty = false := by
    rcases hobs with ⟨_, _, _, _, _, _, b, _, hbEdit⟩
    exact (isEmpty_eq_false_iff_exists_mem _).mpr ⟨.binding b, hbEdit⟩
  have hnoBareBool : m.importEdits.contains .bareSideEffect = false := by
    cases hb : m.importEdits.contains .bareSideEffect
    · rfl
    · exact absurd (List.contains_iff_mem.mp hb) hnobare
  have hseedObs : ExportMayObserveHunk (toImportSeedModuleIR m) sym :=
    (exportMayObserveHunk_toImportSeed_iff m sym).mpr hobs
  have hmem := private_helper_attribution_sound (toImportSeedModuleIR m) hwf hpure
    (allHunksInKnownDecls_toImportSeed m) sym hseedObs
  unfold attributeImportLineEdits
  simp only [hnonempty, hpure, hnoBareBool, Bool.false_eq_true, Bool.not_true, Bool.or_self,
    ↓reduceIte]
  exact hmem

/--
**Exact `↔` Companion (Import-Line Edit Precision):**
In a well-formed pure top-level module with no bare side-effect import edits, an export `sym` is
attributed if and only if it transitively references a changed import binding.
-/
theorem import_line_edit_exact_iff (m : ImportModuleIR)
    (hwf : ∀ a ∈ m.decls, ∀ b ∈ m.uses a, b ∈ m.decls)
    (hpure : m.isPureTopLevel = true)
    (hnobare : ImportLineEdit.bareSideEffect ∉ m.importEdits)
    (sym : Symbol) :
    sym ∈ (attributeImportLineEdits m).exports ↔ ExportMayObserveImportEdit m sym := by
  constructor
  · intro hmem
    unfold attributeImportLineEdits at hmem
    cases hempty : m.importEdits.isEmpty with
    | true => simp [hempty] at hmem
    | false =>
      have hnoBareBool : m.importEdits.contains .bareSideEffect = false := by
        cases hb : m.importEdits.contains .bareSideEffect
        · rfl
        · exact absurd (List.contains_iff_mem.mp hb) hnobare
      simp only [hempty, hpure, hnoBareBool, Bool.false_eq_true, Bool.not_true, Bool.or_self,
        ↓reduceIte] at hmem
      exact (exportMayObserveHunk_toImportSeed_iff m sym).mp
        (private_helper_attribution_precise (toImportSeedModuleIR m) hpure
          (allHunksInKnownDecls_toImportSeed m) sym hmem)
  · exact import_line_edit_sound m hwf hpure hnobare sym

/--
**Theorem 5 (Bare Side-Effect Import & Impure Module Widening):**
If a non-empty import-line edit touches either an impure top-level module (`isPureTopLevel = false`)
or a bare side-effect import (`import "./x"`), `attributeImportLineEdits` widens conservatively:
`complete = false` AND every declared export of `m` is included in `exports`.
-/
theorem side_effect_import_widens (m : ImportModuleIR)
    (hnonempty : m.importEdits.isEmpty = false)
    (hwiden : m.isPureTopLevel = false ∨ ImportLineEdit.bareSideEffect ∈ m.importEdits) :
    (attributeImportLineEdits m).complete = false ∧
    ∀ e ∈ m.decls, ∀ sym, m.exportedName e = some sym →
      sym ∈ (attributeImportLineEdits m).exports := by
  have hcond : (!m.isPureTopLevel || m.importEdits.contains .bareSideEffect) = true := by
    rcases hwiden with himpure | hbare
    · simp [himpure]
    · simp [hbare]
  unfold attributeImportLineEdits
  simp only [hnonempty, hcond, Bool.false_eq_true, ↓reduceIte]
  refine ⟨trivial, ?_⟩
  intro e he sym hexp
  unfold allImportModuleExports
  exact List.mem_filterMap.mpr ⟨e, he, hexp⟩

/-!
## B.2 — Newly-Added Pure vs Impure Module Attribution
When a brand-new module is added to the workspace:
- If its top-level statements are pure (`isPureTopLevel = true`), importing it has no top-level
  side effects, so downstream modules can only observe its declared runtime exports; seeding
  `complete = true, semanticChange = true, exports = declaredExports` covers every observable
  runtime symbol while allowing unrelated downstream modules that never resolve an import to it
  to stay unaffected.
- If its top-level statements are impure (`isPureTopLevel = false`), attributing it as
  `complete = false` raises `unattributed-module-change` and widens conservatively.
-/

/-- Specification of a newly-added JS/TS module in the workspace diff. -/
structure NewModuleSpec where
  id : ModuleId
  /-- True iff every top-level statement in the newly-added module is side-effect-free. -/
  isPureTopLevel : Bool
  /-- All declared runtime symbols exported by the newly-added module. -/
  declaredExports : List Symbol
  deriving DecidableEq, Repr

/-- Executable change-evidence attribution for a newly-added module. -/
def attributeNewModule (nm : NewModuleSpec) : ChangeEvidence :=
  if nm.isPureTopLevel then
    { complete := true, semanticChange := true, exports := nm.declaredExports }
  else
    { complete := false, semanticChange := true, exports := [] }

/--
Downstream module `src` observes runtime symbol `s` from `tgt` via a resolved runtime import edge
in `g.edges`.
-/
def DownstreamObservesRuntimeSymbol (g : DepGraph) (src tgt : ModuleId) (s : Symbol) : Prop :=
  (∃ req, s ∈ req ∧ { source := src, target := tgt, kind := .namedRuntime req } ∈ g.edges) ∨
  (∃ members, s ∈ members ∧ { source := src, target := tgt, kind := .namespaceTracked members } ∈ g.edges) ∨
  (s ≠ "default" ∧ { source := src, target := tgt, kind := .reexportAll } ∈ g.edges) ∨
  { source := src, target := tgt, kind := .bareRuntime } ∈ g.edges ∨
  { source := src, target := tgt, kind := .boundedDynamic } ∈ g.edges

/--
**Theorem 6 (Newly-Added Pure Module Soundness):**
For any newly-added pure module `nm`, its attributed `exports` cover every declared runtime symbol
`s ∈ nm.declaredExports`, seed `ImpactedSymbol g .runtime changed nm.id s`, mark every downstream
importer resolving a runtime import edge observing `s` as `ImpactedModule`, and trigger
`ambiguous-cross-file-import` for any escaped namespace importer of `nm.id`.
-/
theorem new_pure_module_sound
    (g : DepGraph) (changed : List ModuleId) (nm : NewModuleSpec)
    (hpure : nm.isPureTopLevel = true)
    (hmem : nm.id ∈ changed)
    (hch : g.changeOf nm.id = some (attributeNewModule nm))
    {s : Symbol} (hs : s ∈ nm.declaredExports) :
    s ∈ (attributeNewModule nm).exports ∧
    ImpactedSymbol g .runtime changed nm.id s ∧
    (∀ src, DownstreamObservesRuntimeSymbol g src nm.id s →
      ImpactedModule g .runtime changed src) ∧
    (∀ src, { source := src, target := nm.id, kind := .namespaceEscaped } ∈ g.edges →
      TriggeredUncertainty g .runtime changed
        { path := src, code := "ambiguous-cross-file-import", scope := .reachedModule }) := by
  have hcomp : (attributeNewModule nm).complete = true := by
    unfold attributeNewModule; simp [hpure]
  have hsem : (attributeNewModule nm).semanticChange = true := by
    unfold attributeNewModule; simp [hpure]
  have hexp : s ∈ (attributeNewModule nm).exports := by
    unfold attributeNewModule; simp [hpure, hs]
  have hsym : ImpactedSymbol g .runtime changed nm.id s :=
    ImpactedSymbol.seed hmem hch hcomp hsem hexp
  refine ⟨hexp, hsym, ?_, ?_⟩
  · intro src hobs
    rcases hobs with ⟨req, hsReq, hedge⟩ | ⟨members, hsMem, hedge⟩ | ⟨hne, hedge⟩ | hedge | hedge
    · exact ImpactedModule.namedImporter hsym hsReq hedge
    · exact ImpactedModule.namespaceTrackedImporter hsym hsMem hedge
    · exact ImpactedModule.fromSymbol (ImpactedSymbol.reexportAll hsym hne hedge)
    · exact ImpactedModule.bareImporter hsym hedge
    · exact ImpactedModule.boundedDynamicImporter hsym hedge
  · intro src hedge
    exact TriggeredUncertainty.ambiguousNamespace hsym hedge

/--
**Theorem 7 (Newly-Added Impure Module Widening):**
A newly-added module with top-level side effects (`isPureTopLevel = false`) is attributed with
`complete = false` and triggers `unattributed-module-change`, forcing conservative widening.
-/
theorem new_impure_module_widens
    (g : DepGraph) (ch : AnalysisChannel) (changed : List ModuleId) (nm : NewModuleSpec)
    (himpure : nm.isPureTopLevel = false)
    (hmem : nm.id ∈ changed)
    (hch : g.changeOf nm.id = some (attributeNewModule nm)) :
    (attributeNewModule nm).complete = false ∧
    TriggeredUncertainty g ch changed
      { path := nm.id, code := "unattributed-module-change", scope := .reachedModule } := by
  have hcomp : (attributeNewModule nm).complete = false := by
    unfold attributeNewModule; simp [himpure]
  refine ⟨hcomp, ?_⟩
  apply TriggeredUncertainty.unattributedChange hmem
  rw [hch]
  simp [hcomp]

/--
End-to-end planner corollary: a newly-added impure module in `g.modules` widens its owner project
and every transitive `fallbackDeps` dependent task to `TaskExecutionScope.allTests`.
-/
theorem new_impure_module_widens_plan
    (m : Manifest) (g : DepGraph) (changed : List ModuleId)
    (reqFull : Bool) (fuel : Nat)
    (nm : NewModuleSpec) {p q : ProjectId} {t : TaskSpec}
    (himpure : nm.isPureTopLevel = false)
    (hmem : nm.id ∈ changed)
    (hmod : nm.id ∈ g.modules)
    (hch : g.changeOf nm.id = some (attributeNewModule nm))
    (hOwner : m.ownerOf nm.id = some p)
    (hDep : TransitiveFallbackDep m p q)
    (hAllProj : ∀ x, TransitiveFallbackDep m p x → x ∈ m.projects)
    (ht : t ∈ m.tasks)
    (htProj : t.project = q)
    (htMode : t.impact = .reachability) :
    (buildPlan m (some g) changed reqFull fuel).taskScope t = .allTests := by
  have hmemFiltered : nm.id ∈ changed.filter (fun x => g.modules.contains x) :=
    List.mem_filter.mpr ⟨hmem, List.contains_iff_mem.mpr hmod⟩
  have htrig := (new_impure_module_widens g t.channel
    (changed.filter (fun x => g.modules.contains x)) nm himpure hmemFiltered hch).2
  exact uncertainty_widens_to_all_tests m g changed reqFull fuel htrig hOwner hDep hAllProj ht htProj htMode

end DadTest
