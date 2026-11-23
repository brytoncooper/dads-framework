import DadTest.Types

namespace DadTest

/-- Ground-truth mathematical semantics: which `(module, symbol)` pairs are impacted on `ch`. -/
inductive ImpactedSymbol (g : DepGraph) (ch : AnalysisChannel) (changed : List ModuleId) :
    ModuleId → Symbol → Prop where
  | seed {m : ModuleId} {c : ChangeEvidence} {s : Symbol} :
      m ∈ changed →
      g.changeOf m = some c →
      c.complete = true →
      c.semanticChange = true →
      s ∈ c.exports →
      ImpactedSymbol g ch changed m s
  | reexportAll {src tgt : ModuleId} {s : Symbol} :
      ImpactedSymbol g ch changed tgt s →
      s ≠ "default" →
      { source := src, target := tgt, kind := .reexportAll } ∈ g.edges →
      ImpactedSymbol g ch changed src s
  | namedRuntime {src tgt : ModuleId} {req : List Symbol} {s own : Symbol} :
      ImpactedSymbol g ch changed tgt s →
      s ∈ req →
      { source := src, target := tgt, kind := .namedRuntime req } ∈ g.edges →
      own ∈ g.affectedOwnExports src tgt s →
      ImpactedSymbol g ch changed src own
  | namespaceTracked {src tgt : ModuleId} {members : List Symbol} {s own : Symbol} :
      ImpactedSymbol g ch changed tgt s →
      s ∈ members →
      { source := src, target := tgt, kind := .namespaceTracked members } ∈ g.edges →
      own ∈ g.affectedOwnExports src tgt s →
      ImpactedSymbol g ch changed src own
  | typeOnlyCheck {src tgt : ModuleId} {req : List Symbol} {s own : Symbol} :
      ch = .typecheck →
      ImpactedSymbol g ch changed tgt s →
      s ∈ req →
      { source := src, target := tgt, kind := .typeOnly req } ∈ g.edges →
      own ∈ g.affectedOwnExports src tgt s →
      ImpactedSymbol g ch changed src own
  | bareRuntime {src tgt : ModuleId} {s own : Symbol} :
      ImpactedSymbol g ch changed tgt s →
      { source := src, target := tgt, kind := .bareRuntime } ∈ g.edges →
      own ∈ g.allOwnExports src →
      ImpactedSymbol g ch changed src own
  | boundedDynamic {src tgt : ModuleId} {s own : Symbol} :
      ImpactedSymbol g ch changed tgt s →
      { source := src, target := tgt, kind := .boundedDynamic } ∈ g.edges →
      own ∈ g.allOwnExports src →
      ImpactedSymbol g ch changed src own

/-- Ground-truth mathematical semantics: which modules are impacted on channel `ch`. -/
inductive ImpactedModule (g : DepGraph) (ch : AnalysisChannel) (changed : List ModuleId) :
    ModuleId → Prop where
  | changedSemantic {m : ModuleId} {c : ChangeEvidence} :
      m ∈ changed →
      g.changeOf m = some c →
      c.complete = true →
      c.semanticChange = true →
      ImpactedModule g ch changed m
  | changedUnattributed {m : ModuleId} :
      m ∈ changed →
      (match g.changeOf m with
       | some c => !c.complete
       | none => true) = true →
      ImpactedModule g ch changed m
  | fromSymbol {m : ModuleId} {s : Symbol} :
      ImpactedSymbol g ch changed m s →
      ImpactedModule g ch changed m
  | namedImporter {src tgt : ModuleId} {req : List Symbol} {s : Symbol} :
      ImpactedSymbol g ch changed tgt s →
      s ∈ req →
      { source := src, target := tgt, kind := .namedRuntime req } ∈ g.edges →
      ImpactedModule g ch changed src
  | namespaceTrackedImporter {src tgt : ModuleId} {members : List Symbol} {s : Symbol} :
      ImpactedSymbol g ch changed tgt s →
      s ∈ members →
      { source := src, target := tgt, kind := .namespaceTracked members } ∈ g.edges →
      ImpactedModule g ch changed src
  | typeOnlyImporter {src tgt : ModuleId} {req : List Symbol} {s : Symbol} :
      ch = .typecheck →
      ImpactedSymbol g ch changed tgt s →
      s ∈ req →
      { source := src, target := tgt, kind := .typeOnly req } ∈ g.edges →
      ImpactedModule g ch changed src
  | bareImporter {src tgt : ModuleId} {s : Symbol} :
      ImpactedSymbol g ch changed tgt s →
      { source := src, target := tgt, kind := .bareRuntime } ∈ g.edges →
      ImpactedModule g ch changed src
  | boundedDynamicImporter {src tgt : ModuleId} {s : Symbol} :
      ImpactedSymbol g ch changed tgt s →
      { source := src, target := tgt, kind := .boundedDynamic } ∈ g.edges →
      ImpactedModule g ch changed src

/-- Ground-truth uncertainties that MUST be surfaced whenever a proof stops being provable. -/
inductive TriggeredUncertainty (g : DepGraph) (ch : AnalysisChannel) (changed : List ModuleId) :
    GraphUncertainty → Prop where
  | unattributedChange {m : ModuleId} :
      m ∈ changed →
      (match g.changeOf m with
       | some c => !c.complete
       | none => true) = true →
      TriggeredUncertainty g ch changed
        { path := m, code := "unattributed-module-change", scope := .reachedModule }
  | ambiguousTypeOnly {src tgt : ModuleId} {req : List Symbol} {s : Symbol} :
      ch = .runtime →
      g.erasesTypeOnly = false →
      ImpactedSymbol g ch changed tgt s →
      { source := src, target := tgt, kind := .typeOnly req } ∈ g.edges →
      TriggeredUncertainty g ch changed
        { path := src, code := "ambiguous-cross-file-import", scope := .reachedModule }
  | ambiguousNamespace {src tgt : ModuleId} {s : Symbol} :
      ImpactedSymbol g ch changed tgt s →
      { source := src, target := tgt, kind := .namespaceEscaped } ∈ g.edges →
      TriggeredUncertainty g ch changed
        { path := src, code := "ambiguous-cross-file-import", scope := .reachedModule }
  | declaredWorkspace {u : GraphUncertainty} :
      u ∈ g.declaredUncertainties →
      u.scope = .wholeWorkspace →
      TriggeredUncertainty g ch changed u
  | declaredReached {u : GraphUncertainty} :
      u ∈ g.declaredUncertainties →
      u.scope = .reachedModule →
      ImpactedModule g ch changed u.path →
      TriggeredUncertainty g ch changed u

/-- Output of the executable reachability walk. -/
structure ReachabilityResult where
  paths : List ModuleId
  symbolPairs : List (ModuleId × Symbol)
  uncertainties : List GraphUncertainty
  closed : Bool
  deriving DecidableEq, Repr

private def insertUnique [DecidableEq α] (xs : List α) (x : α) : List α :=
  if x ∈ xs then xs else x :: xs

private def insertMany [DecidableEq α] (xs : List α) (ys : List α) : List α :=
  ys.foldl insertUnique xs

/-- Seed state from `changed` modules (comment/formatting-only edits seed ZERO impact!). -/
def seedReachability (g : DepGraph) (changed : List ModuleId) : ReachabilityResult :=
  changed.foldl
    (fun st m =>
      match g.changeOf m with
      | some c =>
          if c.complete then
            if c.semanticChange then
              let paths := insertUnique st.paths m
              let pairs := insertMany st.symbolPairs (c.exports.map (fun s => (m, s)))
              { st with paths := paths, symbolPairs := pairs }
            else
              st
          else
            let paths := insertUnique st.paths m
            let u : GraphUncertainty :=
              { path := m, code := "unattributed-module-change", scope := .reachedModule }
            { st with paths := paths, uncertainties := insertUnique st.uncertainties u }
      | none =>
          let paths := insertUnique st.paths m
          let u : GraphUncertainty :=
            { path := m, code := "unattributed-module-change", scope := .reachedModule }
          { st with paths := paths, uncertainties := insertUnique st.uncertainties u })
    { paths := [], symbolPairs := [], uncertainties := [], closed := false }

/--
One edge step over all `(target, symbol)` pairs matching `e.target`:
- Uses intra-file `affectedOwnExports` for named/tracked-namespace/typecheck imports
- Skips `import type` edges completely on `.runtime` when `g.erasesTypeOnly = true`
- Tracks `(module, symbol)` pairs so diamond `export *` barrels never drop symbols
-/
def expandEdge (g : DepGraph) (ch : AnalysisChannel) (acc : ReachabilityResult) (e : ImportEdge) :
    ReachabilityResult :=
  let matchingTargets := acc.symbolPairs.filter (fun p => p.1 == e.target)
  if matchingTargets.isEmpty then
    acc
  else
    match e.kind with
    | .typeOnly req =>
        match ch with
        | .runtime =>
            if g.erasesTypeOnly then
              acc
            else
              let u : GraphUncertainty :=
                { path := e.source, code := "ambiguous-cross-file-import", scope := .reachedModule }
              { acc with uncertainties := insertUnique acc.uncertainties u }
        | .typecheck =>
            let matchedSyms := matchingTargets.filterMap (fun p =>
              if req.contains p.2 then some p.2 else none)
            if matchedSyms.isEmpty then
              acc
            else
              let ownPairs :=
                matchedSyms.flatMap (fun s =>
                  (g.affectedOwnExports e.source e.target s).map (fun own => (e.source, own)))
              { acc with
                paths := insertUnique acc.paths e.source
                symbolPairs := insertMany acc.symbolPairs ownPairs }
    | .namespaceEscaped =>
        let u : GraphUncertainty :=
          { path := e.source, code := "ambiguous-cross-file-import", scope := .reachedModule }
        { acc with uncertainties := insertUnique acc.uncertainties u }
    | .reexportAll =>
        let forwarded :=
          matchingTargets.filterMap (fun p =>
            if p.2 != "default" then some (e.source, p.2) else none)
        if forwarded.isEmpty then
          acc
        else
          { acc with
            paths := insertUnique acc.paths e.source
            symbolPairs := insertMany acc.symbolPairs forwarded }
    | .namedRuntime req =>
        let matchedSyms := matchingTargets.filterMap (fun p =>
          if req.contains p.2 then some p.2 else none)
        if matchedSyms.isEmpty then
          acc
        else
          let ownPairs :=
            matchedSyms.flatMap (fun s =>
              (g.affectedOwnExports e.source e.target s).map (fun own => (e.source, own)))
          { acc with
            paths := insertUnique acc.paths e.source
            symbolPairs := insertMany acc.symbolPairs ownPairs }
    | .namespaceTracked members =>
        let matchedSyms := matchingTargets.filterMap (fun p =>
          if members.contains p.2 then some p.2 else none)
        if matchedSyms.isEmpty then
          acc
        else
          let ownPairs :=
            matchedSyms.flatMap (fun s =>
              (g.affectedOwnExports e.source e.target s).map (fun own => (e.source, own)))
          { acc with
            paths := insertUnique acc.paths e.source
            symbolPairs := insertMany acc.symbolPairs ownPairs }
    | .bareRuntime =>
        let ownPairs := (g.allOwnExports e.source).map (fun own => (e.source, own))
        { acc with
          paths := insertUnique acc.paths e.source
          symbolPairs := insertMany acc.symbolPairs ownPairs }
    | .boundedDynamic =>
        let ownPairs := (g.allOwnExports e.source).map (fun own => (e.source, own))
        { acc with
          paths := insertUnique acc.paths e.source
          symbolPairs := insertMany acc.symbolPairs ownPairs }

def expandOnce (g : DepGraph) (ch : AnalysisChannel) (st : ReachabilityResult) : ReachabilityResult :=
  g.edges.foldl (expandEdge g ch) st

/-- Boolean closure certificate checked directly on the final state. -/
def isSeededBool (g : DepGraph) (changed : List ModuleId) (st : ReachabilityResult) : Bool :=
  changed.all fun m =>
    match g.changeOf m with
    | some c =>
        if c.complete then
          if c.semanticChange then
            st.paths.contains m && c.exports.all (fun s => st.symbolPairs.contains (m, s))
          else
            true
        else
          st.paths.contains m &&
          st.uncertainties.contains
            { path := m, code := "unattributed-module-change", scope := .reachedModule }
    | none =>
        st.paths.contains m &&
        st.uncertainties.contains
          { path := m, code := "unattributed-module-change", scope := .reachedModule }

def isEdgeClosedBool (g : DepGraph) (ch : AnalysisChannel) (st : ReachabilityResult) : Bool :=
  st.symbolPairs.all fun (tgt, s) =>
    st.paths.contains tgt &&
    g.edges.all fun e =>
      if e.target != tgt then true
      else
        match e.kind with
        | .typeOnly req =>
            match ch with
            | .runtime =>
                if g.erasesTypeOnly then true
                else
                  st.uncertainties.contains
                    { path := e.source, code := "ambiguous-cross-file-import", scope := .reachedModule }
            | .typecheck =>
                if !req.contains s then true
                else
                  st.paths.contains e.source &&
                  (g.affectedOwnExports e.source e.target s).all (fun own => st.symbolPairs.contains (e.source, own))
        | .namespaceEscaped =>
            st.uncertainties.contains
              { path := e.source, code := "ambiguous-cross-file-import", scope := .reachedModule }
        | .reexportAll =>
            if s == "default" then true
            else st.paths.contains e.source && st.symbolPairs.contains (e.source, s)
        | .namedRuntime req =>
            if !req.contains s then true
            else
              st.paths.contains e.source &&
              (g.affectedOwnExports e.source e.target s).all (fun own => st.symbolPairs.contains (e.source, own))
        | .namespaceTracked members =>
            if !members.contains s then true
            else
              st.paths.contains e.source &&
              (g.affectedOwnExports e.source e.target s).all (fun own => st.symbolPairs.contains (e.source, own))
        | .bareRuntime =>
            st.paths.contains e.source &&
            (g.allOwnExports e.source).all (fun own => st.symbolPairs.contains (e.source, own))
        | .boundedDynamic =>
            st.paths.contains e.source &&
            (g.allOwnExports e.source).all (fun own => st.symbolPairs.contains (e.source, own))

def isDeclaredUncertaintiesClosedBool (g : DepGraph) (st : ReachabilityResult) : Bool :=
  g.declaredUncertainties.all fun u =>
    match u.scope with
    | .wholeWorkspace => st.uncertainties.contains u
    | .reachedModule => !st.paths.contains u.path || st.uncertainties.contains u

def isReachabilityClosed (g : DepGraph) (ch : AnalysisChannel) (changed : List ModuleId)
    (st : ReachabilityResult) : Bool :=
  isSeededBool g changed st && isEdgeClosedBool g ch st && isDeclaredUncertaintiesClosedBool g st

private def collectDeclaredUncertainties (g : DepGraph) (st : ReachabilityResult) : ReachabilityResult :=
  let extra :=
    g.declaredUncertainties.filter fun u =>
      u.scope == .wholeWorkspace || st.paths.contains u.path
  { st with uncertainties := insertMany st.uncertainties extra }

private def iterateFixpoint (g : DepGraph) (ch : AnalysisChannel) :
    Nat → ReachabilityResult → ReachabilityResult
  | 0, st => st
  | n + 1, st =>
      let next := expandOnce g ch st
      if next.paths.length == st.paths.length &&
         next.symbolPairs.length == st.symbolPairs.length &&
         next.uncertainties.length == st.uncertainties.length then
        next
      else
        iterateFixpoint g ch n next

/--
Executable symbol reachability with fail-closed certificate verification.
When `closed = true`, we prove BOTH soundness AND exact precision (`↔`).
-/
def computeReachability (g : DepGraph) (ch : AnalysisChannel) (changed : List ModuleId)
    (fuel : Nat := 1024) : ReachabilityResult :=
  let seeded := seedReachability g changed
  let walked := iterateFixpoint g ch fuel seeded
  let withDeclared := collectDeclaredUncertainties g walked
  if isReachabilityClosed g ch changed withDeclared then
    { withDeclared with closed := true }
  else
    let fallbackU : GraphUncertainty :=
      { path := "", code := "reachability-fixpoint-unclosed", scope := .wholeWorkspace }
    { withDeclared with
      uncertainties := insertUnique withDeclared.uncertainties fallbackU
      closed := false }

-- ============================================================================
-- PART A: Machine-Checked Unbounded SOUNDNESS Theorems (Never Miss an Impact)
-- ============================================================================

private theorem mem_of_contains [DecidableEq α] {xs : List α} {x : α}
    (h : xs.contains x = true) : x ∈ xs :=
  List.elem_iff.mp h

theorem closed_captures_symbol_impact
    {g : DepGraph} {ch : AnalysisChannel} {changed : List ModuleId} {st : ReachabilityResult}
    (hClosed : isReachabilityClosed g ch changed st = true)
    {m : ModuleId} {s : Symbol}
    (hImp : ImpactedSymbol g ch changed m s) :
    (m, s) ∈ st.symbolPairs := by
  have hSeeded : isSeededBool g changed st = true := by
    unfold isReachabilityClosed at hClosed
    simp only [Bool.and_eq_true] at hClosed
    exact hClosed.1.1
  have hEdge : isEdgeClosedBool g ch st = true := by
    unfold isReachabilityClosed at hClosed
    simp only [Bool.and_eq_true] at hClosed
    exact hClosed.1.2
  induction hImp with
  | @seed m c s hm hch hcomp hsem hs =>
      unfold isSeededBool at hSeeded
      have h1 := List.all_eq_true.mp hSeeded m hm
      rw [hch] at h1
      simp only [hcomp, hsem, ↓reduceIte, Bool.and_eq_true] at h1
      exact mem_of_contains (List.all_eq_true.mp h1.2 s hs)
  | @reexportAll src tgt s _ hne hedge ih =>
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (tgt, s) ih
      simp only [Bool.and_eq_true] at hPair
      have hE := List.all_eq_true.mp hPair.2 { source := src, target := tgt, kind := .reexportAll } hedge
      have hneEq : (s == "default") = false := beq_false_of_ne hne
      simp only [bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hneEq, Bool.and_eq_true] at hE
      exact mem_of_contains hE.2
  | @namedRuntime src tgt req s own _ hsReq hedge hown ih =>
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (tgt, s) ih
      simp only [Bool.and_eq_true] at hPair
      have hE := List.all_eq_true.mp hPair.2 { source := src, target := tgt, kind := .namedRuntime req } hedge
      have hReq : req.contains s = true := List.elem_iff.mpr hsReq
      simp only [bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hReq, Bool.not_true, Bool.and_eq_true] at hE
      exact mem_of_contains (List.all_eq_true.mp hE.2 own hown)
  | @namespaceTracked src tgt members s own _ hsMem hedge hown ih =>
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (tgt, s) ih
      simp only [Bool.and_eq_true] at hPair
      have hE := List.all_eq_true.mp hPair.2 { source := src, target := tgt, kind := .namespaceTracked members } hedge
      have hMem : members.contains s = true := List.elem_iff.mpr hsMem
      simp only [bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hMem, Bool.not_true, Bool.and_eq_true] at hE
      exact mem_of_contains (List.all_eq_true.mp hE.2 own hown)
  | @typeOnlyCheck src tgt req s own hch _ hsReq hedge hown ih =>
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (tgt, s) ih
      simp only [Bool.and_eq_true] at hPair
      have hE := List.all_eq_true.mp hPair.2 { source := src, target := tgt, kind := .typeOnly req } hedge
      have hReq : req.contains s = true := List.elem_iff.mpr hsReq
      simp only [bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hch, hReq, Bool.not_true, Bool.and_eq_true] at hE
      exact mem_of_contains (List.all_eq_true.mp hE.2 own hown)
  | @bareRuntime src tgt s own _ hedge hown ih =>
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (tgt, s) ih
      simp only [Bool.and_eq_true] at hPair
      have hE := List.all_eq_true.mp hPair.2 { source := src, target := tgt, kind := .bareRuntime } hedge
      simp only [bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, Bool.and_eq_true] at hE
      exact mem_of_contains (List.all_eq_true.mp hE.2 own hown)
  | @boundedDynamic src tgt s own _ hedge hown ih =>
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (tgt, s) ih
      simp only [Bool.and_eq_true] at hPair
      have hE := List.all_eq_true.mp hPair.2 { source := src, target := tgt, kind := .boundedDynamic } hedge
      simp only [bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, Bool.and_eq_true] at hE
      exact mem_of_contains (List.all_eq_true.mp hE.2 own hown)

theorem closed_captures_module_impact
    {g : DepGraph} {ch : AnalysisChannel} {changed : List ModuleId} {st : ReachabilityResult}
    (hClosed : isReachabilityClosed g ch changed st = true)
    {m : ModuleId}
    (hImp : ImpactedModule g ch changed m) :
    m ∈ st.paths := by
  have hSeeded : isSeededBool g changed st = true := by
    unfold isReachabilityClosed at hClosed
    simp only [Bool.and_eq_true] at hClosed
    exact hClosed.1.1
  have hEdge : isEdgeClosedBool g ch st = true := by
    unfold isReachabilityClosed at hClosed
    simp only [Bool.and_eq_true] at hClosed
    exact hClosed.1.2
  cases hImp with
  | @changedSemantic c hm hch hcomp hsem =>
      unfold isSeededBool at hSeeded
      have h1 := List.all_eq_true.mp hSeeded m hm
      rw [hch] at h1
      simp only [hcomp, hsem, ↓reduceIte, Bool.and_eq_true] at h1
      exact mem_of_contains h1.1
  | @changedUnattributed hm hbad =>
      unfold isSeededBool at hSeeded
      have h1 := List.all_eq_true.mp hSeeded m hm
      cases hch : g.changeOf m with
      | none =>
          rw [hch] at h1
          simp only [Bool.and_eq_true] at h1
          exact mem_of_contains h1.1
      | some c =>
          rw [hch] at hbad h1
          dsimp only at hbad h1
          have hCompFalse : c.complete = false := by
            cases hC : c.complete
            · rfl
            · simp [hC] at hbad
          simp only [hCompFalse, Bool.false_eq_true, ↓reduceIte, Bool.and_eq_true] at h1
          exact mem_of_contains h1.1
  | @fromSymbol s hSym =>
      have hPairMem := closed_captures_symbol_impact hClosed hSym
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (m, s) hPairMem
      simp only [Bool.and_eq_true] at hPair
      exact mem_of_contains hPair.1
  | @namedImporter tgt req s hSym hsReq hedge =>
      have hPairMem := closed_captures_symbol_impact hClosed hSym
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (tgt, s) hPairMem
      simp only [Bool.and_eq_true] at hPair
      have hE := List.all_eq_true.mp hPair.2 { source := m, target := tgt, kind := .namedRuntime req } hedge
      have hReq : req.contains s = true := List.elem_iff.mpr hsReq
      simp only [bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hReq, Bool.not_true, Bool.and_eq_true] at hE
      exact mem_of_contains hE.1
  | @namespaceTrackedImporter tgt members s hSym hsMem hedge =>
      have hPairMem := closed_captures_symbol_impact hClosed hSym
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (tgt, s) hPairMem
      simp only [Bool.and_eq_true] at hPair
      have hE := List.all_eq_true.mp hPair.2 { source := m, target := tgt, kind := .namespaceTracked members } hedge
      have hMem : members.contains s = true := List.elem_iff.mpr hsMem
      simp only [bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hMem, Bool.not_true, Bool.and_eq_true] at hE
      exact mem_of_contains hE.1
  | @typeOnlyImporter tgt req s hch hSym hsReq hedge =>
      have hPairMem := closed_captures_symbol_impact hClosed hSym
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (tgt, s) hPairMem
      simp only [Bool.and_eq_true] at hPair
      have hE := List.all_eq_true.mp hPair.2 { source := m, target := tgt, kind := .typeOnly req } hedge
      have hReq : req.contains s = true := List.elem_iff.mpr hsReq
      simp only [bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hch, hReq, Bool.not_true, Bool.and_eq_true] at hE
      exact mem_of_contains hE.1
  | @bareImporter tgt s hSym hedge =>
      have hPairMem := closed_captures_symbol_impact hClosed hSym
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (tgt, s) hPairMem
      simp only [Bool.and_eq_true] at hPair
      have hE := List.all_eq_true.mp hPair.2 { source := m, target := tgt, kind := .bareRuntime } hedge
      simp only [bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, Bool.and_eq_true] at hE
      exact mem_of_contains hE.1
  | @boundedDynamicImporter tgt s hSym hedge =>
      have hPairMem := closed_captures_symbol_impact hClosed hSym
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (tgt, s) hPairMem
      simp only [Bool.and_eq_true] at hPair
      have hE := List.all_eq_true.mp hPair.2 { source := m, target := tgt, kind := .boundedDynamic } hedge
      simp only [bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, Bool.and_eq_true] at hE
      exact mem_of_contains hE.1

theorem closed_captures_triggered_uncertainty
    {g : DepGraph} {ch : AnalysisChannel} {changed : List ModuleId} {st : ReachabilityResult}
    (hClosed : isReachabilityClosed g ch changed st = true)
    {u : GraphUncertainty}
    (hTrig : TriggeredUncertainty g ch changed u) :
    u ∈ st.uncertainties := by
  have hSeeded : isSeededBool g changed st = true := by
    unfold isReachabilityClosed at hClosed
    simp only [Bool.and_eq_true] at hClosed
    exact hClosed.1.1
  have hEdge : isEdgeClosedBool g ch st = true := by
    unfold isReachabilityClosed at hClosed
    simp only [Bool.and_eq_true] at hClosed
    exact hClosed.1.2
  have hDecl : isDeclaredUncertaintiesClosedBool g st = true := by
    unfold isReachabilityClosed at hClosed
    simp only [Bool.and_eq_true] at hClosed
    exact hClosed.2
  cases hTrig with
  | @unattributedChange m hm hbad =>
      unfold isSeededBool at hSeeded
      have h1 := List.all_eq_true.mp hSeeded m hm
      cases hch : g.changeOf m with
      | none =>
          rw [hch] at h1
          simp only [Bool.and_eq_true] at h1
          exact mem_of_contains h1.2
      | some c =>
          rw [hch] at hbad h1
          dsimp only at hbad h1
          have hCompFalse : c.complete = false := by
            cases hC : c.complete
            · rfl
            · simp [hC] at hbad
          simp only [hCompFalse, Bool.false_eq_true, ↓reduceIte, Bool.and_eq_true] at h1
          exact mem_of_contains h1.2
  | @ambiguousTypeOnly src tgt req s hch hErase hSym hedge =>
      have hPairMem := closed_captures_symbol_impact hClosed hSym
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (tgt, s) hPairMem
      simp only [Bool.and_eq_true] at hPair
      have hE := List.all_eq_true.mp hPair.2 { source := src, target := tgt, kind := .typeOnly req } hedge
      simp only [bne_self_eq_false, Bool.false_eq_true, ↓reduceIte, hch, hErase] at hE
      exact mem_of_contains hE
  | @ambiguousNamespace src tgt s hSym hedge =>
      have hPairMem := closed_captures_symbol_impact hClosed hSym
      unfold isEdgeClosedBool at hEdge
      have hPair := List.all_eq_true.mp hEdge (tgt, s) hPairMem
      simp only [Bool.and_eq_true] at hPair
      have hE := List.all_eq_true.mp hPair.2 { source := src, target := tgt, kind := .namespaceEscaped } hedge
      simp only [bne_self_eq_false, Bool.false_eq_true, ↓reduceIte] at hE
      exact mem_of_contains hE
  | @declaredWorkspace u hu hscope =>
      unfold isDeclaredUncertaintiesClosedBool at hDecl
      have h1 := List.all_eq_true.mp hDecl u hu
      simp only [hscope] at h1
      exact mem_of_contains h1
  | @declaredReached u hu hscope hImp =>
      unfold isDeclaredUncertaintiesClosedBool at hDecl
      have h1 := List.all_eq_true.mp hDecl u hu
      have hPath : st.paths.contains u.path = true := List.elem_iff.mpr (closed_captures_module_impact hClosed hImp)
      simp only [hscope, hPath, Bool.not_true, Bool.false_or] at h1
      exact mem_of_contains h1

theorem computeReachability_sound (g : DepGraph) (ch : AnalysisChannel)
    (changed : List ModuleId) (fuel : Nat) :
    let res := computeReachability g ch changed fuel
    (res.closed = true ∧ isReachabilityClosed g ch changed res = true) ∨
    (∃ u ∈ res.uncertainties, u.scope = .wholeWorkspace) := by
  dsimp only [computeReachability]
  split
  · rename_i hClosed
    left
    exact ⟨rfl, hClosed⟩
  · right
    refine ⟨{ path := "", code := "reachability-fixpoint-unclosed", scope := .wholeWorkspace }, ?_, rfl⟩
    unfold insertUnique
    split
    · assumption
    · exact List.mem_cons_self

-- ============================================================================
-- PART B: Machine-Checked Unbounded PRECISION Theorems (Zero Spurious Impacts!)
-- ============================================================================

/-- Invariant: every recorded path, symbol pair, and uncertainty is genuinely impacted. -/
def PreciseState (g : DepGraph) (ch : AnalysisChannel) (changed : List ModuleId)
    (st : ReachabilityResult) : Prop :=
  (∀ m ∈ st.paths, ImpactedModule g ch changed m) ∧
  (∀ p ∈ st.symbolPairs, ImpactedSymbol g ch changed p.1 p.2) ∧
  (∀ u ∈ st.uncertainties, TriggeredUncertainty g ch changed u)

private theorem mem_insertUnique_iff [DecidableEq α] {xs : List α} {x y : α} :
    y ∈ insertUnique xs x ↔ y = x ∨ y ∈ xs := by
  unfold insertUnique
  split
  · rename_i hx
    constructor
    · intro hy; exact Or.inr hy
    · intro h
      cases h with
      | inl heq => exact heq ▸ hx
      | inr hy => exact hy
  · simp [List.mem_cons]

private theorem mem_insertMany_iff [DecidableEq α] {xs ys : List α} {z : α} :
    z ∈ insertMany xs ys ↔ z ∈ xs ∨ z ∈ ys := by
  unfold insertMany
  induction ys generalizing xs with
  | nil => simp
  | cons y rest ih =>
      simp only [List.foldl_cons, ih, mem_insertUnique_iff, List.mem_cons]
      constructor
      · intro h
        rcases h with (rfl | hxs) | hrest
        · exact Or.inr (Or.inl rfl)
        · exact Or.inl hxs
        · exact Or.inr (Or.inr hrest)
      · intro h
        rcases h with hxs | rfl | hrest
        · exact Or.inl (Or.inr hxs)
        · exact Or.inl (Or.inl rfl)
        · exact Or.inr hrest

private theorem precise_insertUnique_path {g : DepGraph} {ch : AnalysisChannel}
    {changed : List ModuleId} {st : ReachabilityResult} {m : ModuleId}
    (hP : PreciseState g ch changed st) (hm : ImpactedModule g ch changed m) :
    ∀ x ∈ insertUnique st.paths m, ImpactedModule g ch changed x := by
  intro x hx
  rcases mem_insertUnique_iff.mp hx with rfl | hOld
  · exact hm
  · exact hP.1 x hOld

private theorem precise_insertMany_pairs {g : DepGraph} {ch : AnalysisChannel}
    {changed : List ModuleId} {st : ReachabilityResult} {ps : List (ModuleId × Symbol)}
    (hP : PreciseState g ch changed st)
    (hps : ∀ p ∈ ps, ImpactedSymbol g ch changed p.1 p.2) :
    ∀ p ∈ insertMany st.symbolPairs ps, ImpactedSymbol g ch changed p.1 p.2 := by
  intro p hp
  rcases mem_insertMany_iff.mp hp with hOld | hNew
  · exact hP.2.1 p hOld
  · exact hps p hNew

private theorem precise_insertUnique_unc {g : DepGraph} {ch : AnalysisChannel}
    {changed : List ModuleId} {st : ReachabilityResult} {u : GraphUncertainty}
    (hP : PreciseState g ch changed st) (hu : TriggeredUncertainty g ch changed u) :
    ∀ x ∈ insertUnique st.uncertainties u, TriggeredUncertainty g ch changed x := by
  intro x hx
  rcases mem_insertUnique_iff.mp hx with rfl | hOld
  · exact hu
  · exact hP.2.2 x hOld

theorem seedReachability_precise (g : DepGraph) (ch : AnalysisChannel) (changed : List ModuleId) :
    PreciseState g ch changed (seedReachability g changed) := by
  unfold seedReachability
  have hFold : ∀ (l : List ModuleId) (st : ReachabilityResult),
      (∀ m ∈ l, m ∈ changed) →
      PreciseState g ch changed st →
      PreciseState g ch changed
        (l.foldl
          (fun st m =>
            match g.changeOf m with
            | some c =>
                if c.complete then
                  if c.semanticChange then
                    let paths := insertUnique st.paths m
                    let pairs := insertMany st.symbolPairs (c.exports.map (fun s => (m, s)))
                    { st with paths := paths, symbolPairs := pairs }
                  else
                    st
                else
                  let paths := insertUnique st.paths m
                  let u : GraphUncertainty :=
                    { path := m, code := "unattributed-module-change", scope := .reachedModule }
                  { st with paths := paths, uncertainties := insertUnique st.uncertainties u }
            | none =>
                let paths := insertUnique st.paths m
                let u : GraphUncertainty :=
                  { path := m, code := "unattributed-module-change", scope := .reachedModule }
                { st with paths := paths, uncertainties := insertUnique st.uncertainties u })
          st) := by
    intro l
    induction l with
    | nil => intro st _ hSt; exact hSt
    | cons m rest ih =>
        intro st hSub hSt
        simp only [List.foldl_cons]
        apply ih _ (fun x hx => hSub x (List.mem_cons_of_mem m hx))
        have hm : m ∈ changed := hSub m List.mem_cons_self
        cases hch : g.changeOf m with
        | none =>
            have hBad : (match g.changeOf m with | some c => !c.complete | none => true) = true := by
              rw [hch]
            refine ⟨?_, hSt.2.1, ?_⟩
            · exact precise_insertUnique_path hSt (ImpactedModule.changedUnattributed hm hBad)
            · exact precise_insertUnique_unc hSt (TriggeredUncertainty.unattributedChange hm hBad)
        | some c =>
            dsimp only
            cases hComp : c.complete with
            | false =>
                have hBad : (match g.changeOf m with | some c => !c.complete | none => true) = true := by
                  rw [hch]; simp [hComp]
                simp only [Bool.false_eq_true, ↓reduceIte]
                refine ⟨?_, hSt.2.1, ?_⟩
                · exact precise_insertUnique_path hSt (ImpactedModule.changedUnattributed hm hBad)
                · exact precise_insertUnique_unc hSt (TriggeredUncertainty.unattributedChange hm hBad)
            | true =>
                simp only [↓reduceIte]
                cases hSem : c.semanticChange with
                | false =>
                    simp only [Bool.false_eq_true, ↓reduceIte]
                    exact hSt
                | true =>
                    simp only [↓reduceIte]
                    refine ⟨?_, ?_, hSt.2.2⟩
                    · exact precise_insertUnique_path hSt (ImpactedModule.changedSemantic hm hch hComp hSem)
                    · apply precise_insertMany_pairs hSt
                      intro p hp
                      rcases List.mem_map.mp hp with ⟨s, hs, rfl⟩
                      exact ImpactedSymbol.seed hm hch hComp hSem hs
  exact hFold changed { paths := [], symbolPairs := [], uncertainties := [], closed := false }
    (fun _ h => h) ⟨(fun _ h => by cases h), (fun _ h => by cases h), (fun _ h => by cases h)⟩

private theorem expandEdge_precise {g : DepGraph} {ch : AnalysisChannel} {changed : List ModuleId}
    {acc : ReachabilityResult} {e : ImportEdge}
    (heMem : e ∈ g.edges) (hAcc : PreciseState g ch changed acc) :
    PreciseState g ch changed (expandEdge g ch acc e) := by
  rcases e with ⟨src, tgt, kind⟩
  unfold expandEdge
  dsimp only
  generalize hmtDef : acc.symbolPairs.filter (fun p => p.1 == tgt) = mt
  cases hMtEmpty : mt.isEmpty with
  | true =>
      simp only [↓reduceIte]
      exact hAcc
  | false =>
      simp only [Bool.false_eq_true, ↓reduceIte]
      have hMtEx : ∃ p, p ∈ mt := by
        cases hL : mt with
        | nil => simp [hL] at hMtEmpty
        | cons hd _ => exact ⟨hd, List.mem_cons_self⟩
      have hMtImp : ∀ p ∈ mt, p.1 = tgt ∧ ImpactedSymbol g ch changed tgt p.2 := by
        intro p hp
        rw [← hmtDef] at hp
        rcases List.mem_filter.mp hp with ⟨hpAcc, hpEq⟩
        have hEq : p.1 = tgt := beq_iff_eq.mp hpEq
        exact ⟨hEq, hEq ▸ hAcc.2.1 p hpAcc⟩
      cases kind with
      | typeOnly req =>
          dsimp only
          cases ch with
          | runtime =>
              dsimp only
              cases hErase : g.erasesTypeOnly with
              | true =>
                  simp only [↓reduceIte]
                  exact hAcc
              | false =>
                  simp only [Bool.false_eq_true, ↓reduceIte]
                  rcases hMtEx with ⟨p0, hp0⟩
                  have hp0Imp := (hMtImp p0 hp0).2
                  refine ⟨hAcc.1, hAcc.2.1, ?_⟩
                  exact precise_insertUnique_unc hAcc
                    (TriggeredUncertainty.ambiguousTypeOnly rfl hErase hp0Imp heMem)
          | typecheck =>
              dsimp only
              split
              · exact hAcc
              · rename_i hMsNotEmpty
                have hMsEx : ∃ s, s ∈ mt.filterMap (fun p => if req.contains p.2 then some p.2 else none) := by
                  cases hL : mt.filterMap (fun p => if req.contains p.2 then some p.2 else none) with
                  | nil => rw [hL] at hMsNotEmpty; exact False.elim (hMsNotEmpty rfl)
                  | cons hd _ => exact ⟨hd, List.mem_cons_self⟩
                have hMsInfo : ∀ s ∈ mt.filterMap (fun p => if req.contains p.2 then some p.2 else none),
                    s ∈ req ∧ ImpactedSymbol g .typecheck changed tgt s := by
                  intro s hs
                  rcases List.mem_filterMap.mp hs with ⟨p, hpMt, hpSome⟩
                  split at hpSome
                  · rename_i hReq
                    cases hpSome
                    exact ⟨mem_of_contains hReq, (hMtImp p hpMt).2⟩
                  · cases hpSome
                rcases hMsEx with ⟨s0, hs0⟩
                rcases hMsInfo s0 hs0 with ⟨hs0Req, hs0Imp⟩
                refine ⟨?_, ?_, hAcc.2.2⟩
                · exact precise_insertUnique_path hAcc
                    (ImpactedModule.typeOnlyImporter rfl hs0Imp hs0Req heMem)
                · apply precise_insertMany_pairs hAcc
                  intro pair hPair
                  rcases List.mem_flatMap.mp hPair with ⟨s, hsMs, hInMap⟩
                  rcases List.mem_map.mp hInMap with ⟨own, hOwn, rfl⟩
                  rcases hMsInfo s hsMs with ⟨hsReq, hsImp⟩
                  exact ImpactedSymbol.typeOnlyCheck rfl hsImp hsReq heMem hOwn
      | namespaceEscaped =>
          dsimp only
          rcases hMtEx with ⟨p0, hp0⟩
          refine ⟨hAcc.1, hAcc.2.1, ?_⟩
          exact precise_insertUnique_unc hAcc
            (TriggeredUncertainty.ambiguousNamespace (hMtImp p0 hp0).2 heMem)
      | reexportAll =>
          dsimp only
          split
          · exact hAcc
          · rename_i hFwdNotEmpty
            have hFwdEx : ∃ x, x ∈ mt.filterMap (fun p => if p.2 != "default" then some (src, p.2) else none) := by
              cases hL : mt.filterMap (fun p => if p.2 != "default" then some (src, p.2) else none) with
              | nil => rw [hL] at hFwdNotEmpty; exact False.elim (hFwdNotEmpty rfl)
              | cons hd _ => exact ⟨hd, List.mem_cons_self⟩
            have hFwdImp : ∀ x ∈ mt.filterMap (fun p => if p.2 != "default" then some (src, p.2) else none),
                x.1 = src ∧ ImpactedSymbol g ch changed src x.2 := by
              intro x hx
              rcases List.mem_filterMap.mp hx with ⟨p, hpMt, hpSome⟩
              split at hpSome
              · rename_i hNe
                cases hpSome
                have hNeStr : p.2 ≠ "default" := by
                  intro hEq
                  simp [hEq] at hNe
                exact ⟨rfl, ImpactedSymbol.reexportAll (hMtImp p hpMt).2 hNeStr heMem⟩
              · cases hpSome
            rcases hFwdEx with ⟨x0, hx0⟩
            rcases hFwdImp x0 hx0 with ⟨_, hx0Imp⟩
            refine ⟨?_, ?_, hAcc.2.2⟩
            · exact precise_insertUnique_path hAcc (ImpactedModule.fromSymbol hx0Imp)
            · apply precise_insertMany_pairs hAcc
              intro x hx
              rcases hFwdImp x hx with ⟨hx1, hxImp⟩
              rw [hx1]
              exact hxImp
      | namedRuntime req =>
          dsimp only
          split
          · exact hAcc
          · rename_i hMsNotEmpty
            have hMsEx : ∃ s, s ∈ mt.filterMap (fun p => if req.contains p.2 then some p.2 else none) := by
              cases hL : mt.filterMap (fun p => if req.contains p.2 then some p.2 else none) with
              | nil => rw [hL] at hMsNotEmpty; exact False.elim (hMsNotEmpty rfl)
              | cons hd _ => exact ⟨hd, List.mem_cons_self⟩
            have hMsInfo : ∀ s ∈ mt.filterMap (fun p => if req.contains p.2 then some p.2 else none),
                s ∈ req ∧ ImpactedSymbol g ch changed tgt s := by
              intro s hs
              rcases List.mem_filterMap.mp hs with ⟨p, hpMt, hpSome⟩
              split at hpSome
              · rename_i hReq
                cases hpSome
                exact ⟨mem_of_contains hReq, (hMtImp p hpMt).2⟩
              · cases hpSome
            rcases hMsEx with ⟨s0, hs0⟩
            rcases hMsInfo s0 hs0 with ⟨hs0Req, hs0Imp⟩
            refine ⟨?_, ?_, hAcc.2.2⟩
            · exact precise_insertUnique_path hAcc
                (ImpactedModule.namedImporter hs0Imp hs0Req heMem)
            · apply precise_insertMany_pairs hAcc
              intro pair hPair
              rcases List.mem_flatMap.mp hPair with ⟨s, hsMs, hInMap⟩
              rcases List.mem_map.mp hInMap with ⟨own, hOwn, rfl⟩
              rcases hMsInfo s hsMs with ⟨hsReq, hsImp⟩
              exact ImpactedSymbol.namedRuntime hsImp hsReq heMem hOwn
      | namespaceTracked members =>
          dsimp only
          split
          · exact hAcc
          · rename_i hMsNotEmpty
            have hMsEx : ∃ s, s ∈ mt.filterMap (fun p => if members.contains p.2 then some p.2 else none) := by
              cases hL : mt.filterMap (fun p => if members.contains p.2 then some p.2 else none) with
              | nil => rw [hL] at hMsNotEmpty; exact False.elim (hMsNotEmpty rfl)
              | cons hd _ => exact ⟨hd, List.mem_cons_self⟩
            have hMsInfo : ∀ s ∈ mt.filterMap (fun p => if members.contains p.2 then some p.2 else none),
                s ∈ members ∧ ImpactedSymbol g ch changed tgt s := by
              intro s hs
              rcases List.mem_filterMap.mp hs with ⟨p, hpMt, hpSome⟩
              split at hpSome
              · rename_i hMem
                cases hpSome
                exact ⟨mem_of_contains hMem, (hMtImp p hpMt).2⟩
              · cases hpSome
            rcases hMsEx with ⟨s0, hs0⟩
            rcases hMsInfo s0 hs0 with ⟨hs0Mem, hs0Imp⟩
            refine ⟨?_, ?_, hAcc.2.2⟩
            · exact precise_insertUnique_path hAcc
                (ImpactedModule.namespaceTrackedImporter hs0Imp hs0Mem heMem)
            · apply precise_insertMany_pairs hAcc
              intro pair hPair
              rcases List.mem_flatMap.mp hPair with ⟨s, hsMs, hInMap⟩
              rcases List.mem_map.mp hInMap with ⟨own, hOwn, rfl⟩
              rcases hMsInfo s hsMs with ⟨hsMem, hsImp⟩
              exact ImpactedSymbol.namespaceTracked hsImp hsMem heMem hOwn
      | bareRuntime =>
          dsimp only
          rcases hMtEx with ⟨p0, hp0⟩
          have hp0Imp := (hMtImp p0 hp0).2
          refine ⟨?_, ?_, hAcc.2.2⟩
          · exact precise_insertUnique_path hAcc (ImpactedModule.bareImporter hp0Imp heMem)
          · apply precise_insertMany_pairs hAcc
            intro pair hPair
            rcases List.mem_map.mp hPair with ⟨own, hOwn, rfl⟩
            exact ImpactedSymbol.bareRuntime hp0Imp heMem hOwn
      | boundedDynamic =>
          dsimp only
          rcases hMtEx with ⟨p0, hp0⟩
          have hp0Imp := (hMtImp p0 hp0).2
          refine ⟨?_, ?_, hAcc.2.2⟩
          · exact precise_insertUnique_path hAcc (ImpactedModule.boundedDynamicImporter hp0Imp heMem)
          · apply precise_insertMany_pairs hAcc
            intro pair hPair
            rcases List.mem_map.mp hPair with ⟨own, hOwn, rfl⟩
            exact ImpactedSymbol.boundedDynamic hp0Imp heMem hOwn

theorem expandOnce_precise {g : DepGraph} {ch : AnalysisChannel} {changed : List ModuleId}
    {st : ReachabilityResult} (hSt : PreciseState g ch changed st) :
    PreciseState g ch changed (expandOnce g ch st) := by
  unfold expandOnce
  have hFold : ∀ (es : List ImportEdge) (acc : ReachabilityResult),
      (∀ e ∈ es, e ∈ g.edges) →
      PreciseState g ch changed acc →
      PreciseState g ch changed (es.foldl (expandEdge g ch) acc) := by
    intro es
    induction es with
    | nil => intro acc _ hAcc; exact hAcc
    | cons e rest ih =>
        intro acc hSub hAcc
        simp only [List.foldl_cons]
        exact ih _ (fun x hx => hSub x (List.mem_cons_of_mem e hx))
          (expandEdge_precise (hSub e List.mem_cons_self) hAcc)
  exact hFold g.edges st (fun _ h => h) hSt

private theorem iterateFixpoint_precise {g : DepGraph} {ch : AnalysisChannel}
    {changed : List ModuleId} {st : ReachabilityResult} (fuel : Nat)
    (hSt : PreciseState g ch changed st) :
    PreciseState g ch changed (iterateFixpoint g ch fuel st) := by
  induction fuel generalizing st with
  | zero => exact hSt
  | succ n ih =>
      unfold iterateFixpoint
      dsimp only
      split
      · exact expandOnce_precise hSt
      · exact ih (expandOnce_precise hSt)

private theorem collectDeclaredUncertainties_precise {g : DepGraph} {ch : AnalysisChannel}
    {changed : List ModuleId} {st : ReachabilityResult}
    (hSt : PreciseState g ch changed st) :
    PreciseState g ch changed (collectDeclaredUncertainties g st) := by
  unfold collectDeclaredUncertainties
  refine ⟨hSt.1, hSt.2.1, ?_⟩
  intro u hu
  rcases mem_insertMany_iff.mp hu with hOld | hExtra
  · exact hSt.2.2 u hOld
  · rcases List.mem_filter.mp hExtra with ⟨huDecl, hCond⟩
    rcases Bool.or_eq_true_iff.mp hCond with hWs | hPath
    · exact TriggeredUncertainty.declaredWorkspace huDecl (beq_iff_eq.mp hWs)
    · cases hScope : u.scope with
      | wholeWorkspace => exact TriggeredUncertainty.declaredWorkspace huDecl hScope
      | reachedModule =>
          exact TriggeredUncertainty.declaredReached huDecl hScope
            (hSt.1 u.path (mem_of_contains hPath))

/--
Precision of `computeReachability`: whenever `res.closed = true`, EVERY returned
path, symbol pair, and uncertainty is genuinely impacted (zero spurious entries!).
-/
theorem computeReachability_precise
    {g : DepGraph} {ch : AnalysisChannel} {changed : List ModuleId} {fuel : Nat}
    (hClosed : (computeReachability g ch changed fuel).closed = true) :
    PreciseState g ch changed (computeReachability g ch changed fuel) := by
  have hBase : PreciseState g ch changed
      (collectDeclaredUncertainties g (iterateFixpoint g ch fuel (seedReachability g changed))) :=
    collectDeclaredUncertainties_precise (iterateFixpoint_precise fuel (seedReachability_precise g ch changed))
  unfold computeReachability at hClosed ⊢
  dsimp only at hClosed ⊢
  split at hClosed
  · rename_i hCond
    simp only [hCond, ↓reduceIte]
    exact hBase
  · simp at hClosed

/--
EXACT CHARACTERIZATION (Soundness + Precision `↔`):
Whenever `res.closed = true`, `computeReachability` computes the EXACT mathematical
sets of impacted symbols, impacted modules, and triggered uncertainties — not one
missing AND not one extra!
-/
theorem computeReachability_exact_iff
    {g : DepGraph} {ch : AnalysisChannel} {changed : List ModuleId} {fuel : Nat}
    (hClosed : (computeReachability g ch changed fuel).closed = true) :
    let res := computeReachability g ch changed fuel
    (∀ m s, (m, s) ∈ res.symbolPairs ↔ ImpactedSymbol g ch changed m s) ∧
    (∀ m, m ∈ res.paths ↔ ImpactedModule g ch changed m) ∧
    (∀ u, u ∈ res.uncertainties ↔ TriggeredUncertainty g ch changed u) := by
  have hPrec := computeReachability_precise hClosed
  have hCert : isReachabilityClosed g ch changed (computeReachability g ch changed fuel) = true := by
    unfold computeReachability at hClosed ⊢
    dsimp only at hClosed ⊢
    split at hClosed
    · rename_i hCond
      simp only [hCond, ↓reduceIte]
      exact hCond
    · simp at hClosed
  refine ⟨?_, ?_, ?_⟩
  · intro m s
    exact ⟨fun h => hPrec.2.1 (m, s) h, fun h => closed_captures_symbol_impact hCert h⟩
  · intro m
    exact ⟨fun h => hPrec.1 m h, fun h => closed_captures_module_impact hCert h⟩
  · intro u
    exact ⟨fun h => hPrec.2.2 u h, fun h => closed_captures_triggered_uncertainty hCert h⟩

end DadTest
