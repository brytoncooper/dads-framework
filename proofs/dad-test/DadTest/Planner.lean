import DadTest.Reachability

namespace DadTest

/-- Transitive dependent relation: `dep` transitively depends on `base` via `fallbackDeps`. -/
inductive TransitiveFallbackDep (m : Manifest) : ProjectId → ProjectId → Prop where
  | refl (p : ProjectId) : TransitiveFallbackDep m p p
  | step {base mid dep : ProjectId} :
      TransitiveFallbackDep m base mid →
      mid ∈ m.fallbackDeps dep →
      TransitiveFallbackDep m base dep

/-- Transitive prerequisite relation: `t` transitively requires `prereq` via `dependsOn`. -/
inductive TransitiveTaskPrereq (m : Manifest) : TaskId → TaskId → Prop where
  | refl (tid : TaskId) : TransitiveTaskPrereq m tid tid
  | step {tId mid dep : TaskId} {tk : TaskSpec} :
      TransitiveTaskPrereq m tId mid →
      tk ∈ m.tasks →
      tk.id = mid →
      dep ∈ tk.dependsOn →
      TransitiveTaskPrereq m tId dep

/-- Planned output for all tasks, supporting exact file-level test selection. -/
structure PlanOutput where
  fullFallback : Bool
  reachedPaths : AnalysisChannel → List ModuleId
  widenedProjects : AnalysisChannel → List ProjectId
  selectedTasks : List TaskId
  taskScope : TaskSpec → TaskExecutionScope

private def insertUnique [DecidableEq α] (xs : List α) (x : α) : List α :=
  if x ∈ xs then xs else x :: xs

private def insertMany [DecidableEq α] (xs : List α) (ys : List α) : List α :=
  ys.foldl insertUnique xs

/-- Propagate impacted projects forward through `fallbackDeps`. -/
def expandDependentsStep (m : Manifest) (ps : List ProjectId) : List ProjectId :=
  m.projects.foldl
    (fun acc p =>
      if (m.fallbackDeps p).any (fun dep => acc.contains dep) then
        insertUnique acc p
      else
        acc)
    ps

def propagateDependents (m : Manifest) (seed : List ProjectId) (fuel : Nat := 256) : List ProjectId :=
  match fuel with
  | 0 => seed
  | n + 1 =>
      let next := expandDependentsStep m seed
      if next.length == seed.length then next else propagateDependents m next n

def isDependentsClosed (m : Manifest) (ps : List ProjectId) : Bool :=
  m.projects.all fun p =>
    !((m.fallbackDeps p).any (fun dep => ps.contains dep)) || ps.contains p

/-- Propagate task prerequisites backwards through `dependsOn`. -/
def expandPrereqsStep (m : Manifest) (selected : List TaskId) : List TaskId :=
  m.tasks.foldl
    (fun acc t =>
      if acc.contains t.id then insertMany acc t.dependsOn else acc)
    selected

def propagatePrereqs (m : Manifest) (seed : List TaskId) (fuel : Nat := 256) : List TaskId :=
  match fuel with
  | 0 => seed
  | n + 1 =>
      let next := expandPrereqsStep m seed
      if next.length == seed.length then next else propagatePrereqs m next n

def isPrereqsClosed (m : Manifest) (selected : List TaskId) : Bool :=
  m.tasks.all fun t =>
    !selected.contains t.id || t.dependsOn.all (fun dep => selected.contains dep)

/-- Whether a changed path is declared as a non-JS asset by at least one task. -/
def isDeclaredAsset (m : Manifest) (p : ModuleId) : Bool :=
  m.tasks.any (fun t => t.assetPaths.contains p)

/-- Intermediate structured state for graph-backed planning (runtime + typecheck channels). -/
structure GraphPlanState where
  reachRuntime : ReachabilityResult
  reachTypecheck : ReachabilityResult
  fallbackProjects : List ProjectId
  widenedRuntime : List ProjectId
  widenedTypecheck : List ProjectId
  reachabilityProjectsRuntime : List ProjectId
  reachabilityProjectsTypecheck : List ProjectId
  baseFull : Bool
  baseSelected : List TaskId
  selected : List TaskId
  finalFull : Bool
  finalSelected : List TaskId

def GraphPlanState.reachFor (st : GraphPlanState) : AnalysisChannel → ReachabilityResult
  | .runtime => st.reachRuntime
  | .typecheck => st.reachTypecheck

def GraphPlanState.widenedFor (st : GraphPlanState) : AnalysisChannel → List ProjectId
  | .runtime => st.widenedRuntime
  | .typecheck => st.widenedTypecheck

def GraphPlanState.reachProjectsFor (st : GraphPlanState) : AnalysisChannel → List ProjectId
  | .runtime => st.reachabilityProjectsRuntime
  | .typecheck => st.reachabilityProjectsTypecheck

def computeGraphPlanState
    (m : Manifest)
    (graph : DepGraph)
    (changed : List ModuleId)
    (requestedFullFallback : Bool)
    (fuel : Nat) : GraphPlanState :=
  let ownedChanged := changed.filterMap m.ownerOf
  let hasUnownedChanged := changed.any (fun p => (m.ownerOf p).isNone)
  -- Only JS/TS module paths enter the JS reachability walk; declared assets route to their tasks.
  let moduleChanged := changed.filter (fun p => graph.modules.contains p)
  let uncoveredPaths := changed.filter (fun p => !graph.modules.contains p && !isDeclaredAsset m p)
  let uncoveredOwners := uncoveredPaths.filterMap m.ownerOf
  let reachRuntime := computeReachability graph .runtime moduleChanged fuel
  let reachTypecheck := computeReachability graph .typecheck moduleChanged fuel
  let hasUnownedReached :=
    reachRuntime.paths.any (fun p => (m.ownerOf p).isNone) ||
    reachTypecheck.paths.any (fun p => (m.ownerOf p).isNone)
  let hasWorkspaceUncertainty :=
    reachRuntime.uncertainties.any (fun u => u.scope == .wholeWorkspace) ||
    reachTypecheck.uncertainties.any (fun u => u.scope == .wholeWorkspace)
  let hasUnownedUncertainty :=
    reachRuntime.uncertainties.any (fun u => (m.ownerOf u.path).isNone) ||
    reachTypecheck.uncertainties.any (fun u => (m.ownerOf u.path).isNone)
  let uncOwnersRuntime :=
    insertMany uncoveredOwners (reachRuntime.uncertainties.filterMap (fun u => m.ownerOf u.path))
  let uncOwnersTypecheck :=
    insertMany uncoveredOwners (reachTypecheck.uncertainties.filterMap (fun u => m.ownerOf u.path))
  let projectSeed := insertMany (insertMany ownedChanged uncOwnersRuntime) uncOwnersTypecheck
  let fallbackProjects := propagateDependents m projectSeed fuel
  let widenedRuntime := propagateDependents m uncOwnersRuntime fuel
  let widenedTypecheck := propagateDependents m uncOwnersTypecheck fuel
  let reachabilityProjectsRuntime :=
    insertMany (reachRuntime.paths.filterMap m.ownerOf) widenedRuntime
  let reachabilityProjectsTypecheck :=
    insertMany (reachTypecheck.paths.filterMap m.ownerOf) widenedTypecheck
  let baseFull :=
    requestedFullFallback ||
    hasUnownedChanged ||
    hasUnownedReached ||
    hasWorkspaceUncertainty ||
    hasUnownedUncertainty ||
    !reachRuntime.closed ||
    !reachTypecheck.closed ||
    !isDependentsClosed m fallbackProjects ||
    !isDependentsClosed m widenedRuntime ||
    !isDependentsClosed m widenedTypecheck
  let baseSelected :=
    if baseFull then m.tasks.map (·.id)
    else
      (m.tasks.filter fun t =>
        match t.impact with
        | .always => true
        | .changedFiles owned => changed.any (fun p => owned.contains p)
        | .project => fallbackProjects.contains t.project
        | .reachability =>
            let assetHit := changed.any (fun p => t.assetPaths.contains p)
            let projHit :=
              match t.channel with
              | .runtime => reachabilityProjectsRuntime.contains t.project
              | .typecheck => reachabilityProjectsTypecheck.contains t.project
            assetHit || projHit).map (·.id)
  let selected := propagatePrereqs m baseSelected fuel
  let finalFull := baseFull || !isPrereqsClosed m selected
  let finalSelected := if finalFull then m.tasks.map (·.id) else selected
  { reachRuntime
    reachTypecheck
    fallbackProjects
    widenedRuntime
    widenedTypecheck
    reachabilityProjectsRuntime
    reachabilityProjectsTypecheck
    baseFull
    baseSelected
    selected
    finalFull
    finalSelected }

/--
Core planner with fail-closed widening AND exact file-level test narrowing.
When `fullFallback = false`, `t.impact = .reachability`, `t.project ∉ widenedProjects`,
no declared asset of `t` changed, and `!t.testFiles.isEmpty`:
- `taskScope t = .subset hitTests` if at least one `f ∈ t.testFiles` was reached
- `taskScope t = .skipProvenUnaffected` if zero `f ∈ t.testFiles` were reached!
-/
def buildPlan
    (m : Manifest)
    (g : Option DepGraph)
    (changed : List ModuleId)
    (requestedFullFallback : Bool := false)
    (fuel : Nat := 256) : PlanOutput :=
  match g with
  | none =>
      let ownedChanged := changed.filterMap m.ownerOf
      let hasUnownedChanged := changed.any (fun p => (m.ownerOf p).isNone)
      let widened := propagateDependents m ownedChanged fuel
      let full := requestedFullFallback || hasUnownedChanged || !isDependentsClosed m widened
      let baseSelected :=
        if full then m.tasks.map (·.id)
        else
          (m.tasks.filter fun t =>
            match t.impact with
            | .always => true
            | .changedFiles owned => changed.any (fun p => owned.contains p)
            | .project => widened.contains t.project
            | .reachability => widened.contains t.project).map (·.id)
      let selected := propagatePrereqs m baseSelected fuel
      let finalFull := full || !isPrereqsClosed m selected
      let finalSelected := if finalFull then m.tasks.map (·.id) else selected
      { fullFallback := finalFull
        reachedPaths := fun _ => changed
        widenedProjects := fun _ => widened
        selectedTasks := finalSelected
        taskScope := fun t =>
          if finalFull || finalSelected.contains t.id then .allTests else .skipProvenUnaffected }
  | some graph =>
      let st := computeGraphPlanState m graph changed requestedFullFallback fuel
      { fullFallback := st.finalFull
        reachedPaths := fun ch => (st.reachFor ch).paths
        widenedProjects := st.widenedFor
        selectedTasks := st.finalSelected
        taskScope := fun t =>
          if st.finalFull then .allTests
          else if !st.finalSelected.contains t.id then .skipProvenUnaffected
          else
            match t.impact with
            | .reachability =>
                if (st.widenedFor t.channel).contains t.project then
                  .allTests
                else if changed.any (fun p => t.assetPaths.contains p) then
                  .allTests
                else if t.testFiles.isEmpty then
                  .allTests
                else
                  let hitTests := t.testFiles.filter (fun f => (st.reachFor t.channel).paths.contains f)
                  if hitTests.isEmpty then .skipProvenUnaffected else .subset hitTests
            | _ => .allTests }

-- ============================================================================
-- Helper Lemmas
-- ============================================================================

private theorem mem_of_contains [DecidableEq α] {xs : List α} {x : α}
    (h : xs.contains x = true) : x ∈ xs :=
  List.elem_iff.mp h

private theorem contains_of_mem [DecidableEq α] {xs : List α} {x : α}
    (h : x ∈ xs) : xs.contains x = true :=
  List.elem_iff.mpr h

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

private theorem mem_insertUnique_of_mem [DecidableEq α] {xs : List α} {x y : α}
    (h : x ∈ xs) : x ∈ insertUnique xs y :=
  mem_insertUnique_iff.mpr (Or.inr h)

private theorem mem_insertMany_left [DecidableEq α] {xs ys : List α} {x : α}
    (h : x ∈ xs) : x ∈ insertMany xs ys :=
  mem_insertMany_iff.mpr (Or.inl h)

private theorem mem_insertMany_right [DecidableEq α] {xs ys : List α} {y : α}
    (h : y ∈ ys) : y ∈ insertMany xs ys :=
  mem_insertMany_iff.mpr (Or.inr h)

private theorem mem_expandDependentsStep_of_mem {m : Manifest} {ps : List ProjectId} {p : ProjectId}
    (h : p ∈ ps) : p ∈ expandDependentsStep m ps := by
  unfold expandDependentsStep
  have hfold : ∀ (l : List ProjectId) (acc : List ProjectId), p ∈ acc →
      p ∈ l.foldl (fun acc q => if (m.fallbackDeps q).any (fun dep => acc.contains dep) then insertUnique acc q else acc) acc := by
    intro l
    induction l with
    | nil => intro acc hacc; exact hacc
    | cons q qs ih =>
        intro acc hacc
        simp only [List.foldl_cons]
        apply ih
        split
        · exact mem_insertUnique_of_mem hacc
        · exact hacc
  exact hfold m.projects ps h

private theorem mem_propagateDependents_of_mem {m : Manifest} {seed : List ProjectId} {p : ProjectId}
    (fuel : Nat) (h : p ∈ seed) : p ∈ propagateDependents m seed fuel := by
  induction fuel generalizing seed with
  | zero => exact h
  | succ n ih =>
      unfold propagateDependents
      dsimp only
      split
      · exact mem_expandDependentsStep_of_mem h
      · exact ih (mem_expandDependentsStep_of_mem h)

private theorem mem_expandPrereqsStep_of_mem {m : Manifest} {sel : List TaskId} {t : TaskId}
    (h : t ∈ sel) : t ∈ expandPrereqsStep m sel := by
  unfold expandPrereqsStep
  have hfold : ∀ (l : List TaskSpec) (acc : List TaskId), t ∈ acc →
      t ∈ l.foldl (fun acc tk => if acc.contains tk.id then insertMany acc tk.dependsOn else acc) acc := by
    intro l
    induction l with
    | nil => intro acc hacc; exact hacc
    | cons tk tks ih =>
        intro acc hacc
        simp only [List.foldl_cons]
        apply ih
        split
        · exact mem_insertMany_left hacc
        · exact hacc
  exact hfold m.tasks sel h

private theorem mem_propagatePrereqs_of_mem {m : Manifest} {seed : List TaskId} {t : TaskId}
    (fuel : Nat) (h : t ∈ seed) : t ∈ propagatePrereqs m seed fuel := by
  induction fuel generalizing seed with
  | zero => exact h
  | succ n ih =>
      unfold propagatePrereqs
      dsimp only
      split
      · exact mem_expandPrereqsStep_of_mem h
      · exact ih (mem_expandPrereqsStep_of_mem h)

/-- Precision of prerequisite propagation: every task added by `propagatePrereqs` is
    transitively required by some task in `seed`. -/
private theorem expandPrereqsStep_precise {m : Manifest} {seed acc : List TaskId}
    (hInv : ∀ x ∈ acc, ∃ s ∈ seed, TransitiveTaskPrereq m s x) :
    ∀ x ∈ expandPrereqsStep m acc, ∃ s ∈ seed, TransitiveTaskPrereq m s x := by
  unfold expandPrereqsStep
  have hFold : ∀ (ts : List TaskSpec) (cur : List TaskId),
      (∀ tk ∈ ts, tk ∈ m.tasks) →
      (∀ x ∈ cur, ∃ s ∈ seed, TransitiveTaskPrereq m s x) →
      ∀ x ∈ ts.foldl (fun a tk => if a.contains tk.id then insertMany a tk.dependsOn else a) cur,
        ∃ s ∈ seed, TransitiveTaskPrereq m s x := by
    intro ts
    induction ts with
    | nil => intro cur _ hCur; exact hCur
    | cons tk rest ih =>
        intro cur hSub hCur
        simp only [List.foldl_cons]
        apply ih _ (fun t ht => hSub t (List.mem_cons_of_mem tk ht))
        intro x hx
        split at hx
        · rename_i hContains
          rcases mem_insertMany_iff.mp hx with hOld | hDep
          · exact hCur x hOld
          · rcases hCur tk.id (mem_of_contains hContains) with ⟨s, hsSeed, hPath⟩
            exact ⟨s, hsSeed, TransitiveTaskPrereq.step hPath (hSub tk List.mem_cons_self) rfl hDep⟩
        · exact hCur x hx
  exact hFold m.tasks acc (fun _ h => h) hInv

private theorem propagatePrereqs_precise {m : Manifest} {seed : List TaskId} (fuel : Nat) :
    ∀ x ∈ propagatePrereqs m seed fuel, ∃ s ∈ seed, TransitiveTaskPrereq m s x := by
  have hGen : ∀ (n : Nat) (cur : List TaskId),
      (∀ x ∈ cur, ∃ s ∈ seed, TransitiveTaskPrereq m s x) →
      ∀ x ∈ propagatePrereqs m cur n, ∃ s ∈ seed, TransitiveTaskPrereq m s x := by
    intro n
    induction n with
    | zero => intro cur hCur; exact hCur
    | succ k ih =>
        intro cur hCur
        unfold propagatePrereqs
        dsimp only
        split
        · exact expandPrereqsStep_precise hCur
        · exact ih _ (expandPrereqsStep_precise hCur)
  exact hGen fuel seed (fun x hx => ⟨x, hx, TransitiveTaskPrereq.refl x⟩)

private theorem closed_dependents_transitive
    {m : Manifest} {ps : List ProjectId}
    (hClosed : isDependentsClosed m ps = true)
    {p q : ProjectId}
    (hp : p ∈ ps)
    (hDep : TransitiveFallbackDep m p q)
    (hAllProj : ∀ x, TransitiveFallbackDep m p x → x ∈ m.projects) :
    q ∈ ps := by
  induction hDep with
  | refl => exact hp
  | @step mid dep hbm hmidDep ih =>
      have hMidMem : mid ∈ ps := ih
      have hDepProj : dep ∈ m.projects := hAllProj dep (TransitiveFallbackDep.step hbm hmidDep)
      unfold isDependentsClosed at hClosed
      have hRule := List.all_eq_true.mp hClosed dep hDepProj
      have hAny : (m.fallbackDeps dep).any (fun d => ps.contains d) = true :=
        List.any_eq_true.mpr ⟨mid, hmidDep, contains_of_mem hMidMem⟩
      simp only [hAny, Bool.not_true, Bool.false_or] at hRule
      exact mem_of_contains hRule

private theorem graph_finalSelected_eq_of_false
    {m : Manifest} {g : DepGraph} {changed : List ModuleId} {reqFull : Bool} {fuel : Nat}
    (h : (computeGraphPlanState m g changed reqFull fuel).finalFull = false) :
    (computeGraphPlanState m g changed reqFull fuel).finalSelected =
      (computeGraphPlanState m g changed reqFull fuel).selected := by
  unfold computeGraphPlanState at h ⊢
  dsimp only at h ⊢
  simp only [h, Bool.false_eq_true, ↓reduceIte]

private theorem graph_finalSelected_eq_of_true
    {m : Manifest} {g : DepGraph} {changed : List ModuleId} {reqFull : Bool} {fuel : Nat}
    (h : (computeGraphPlanState m g changed reqFull fuel).finalFull = true) :
    (computeGraphPlanState m g changed reqFull fuel).finalSelected =
      m.tasks.map (·.id) := by
  unfold computeGraphPlanState at h ⊢
  dsimp only at h ⊢
  simp only [h, ↓reduceIte]

private theorem graph_not_full_implies_closed
    {m : Manifest} {g : DepGraph} {changed : List ModuleId} {reqFull : Bool} {fuel : Nat}
    (hNotFull : (computeGraphPlanState m g changed reqFull fuel).finalFull = false) :
    let st := computeGraphPlanState m g changed reqFull fuel
    let modChanged := changed.filter (fun p => g.modules.contains p)
    st.baseFull = false ∧
    (∀ ch, (st.reachFor ch).closed = true ∧ isReachabilityClosed g ch modChanged (st.reachFor ch) = true) ∧
    (∀ ch, isDependentsClosed m (st.widenedFor ch) = true) ∧
    isPrereqsClosed m st.selected = true := by
  unfold computeGraphPlanState at hNotFull ⊢
  dsimp only at hNotFull ⊢
  have hPair := Bool.or_eq_false_iff.mp hNotFull
  have hBaseEq := hPair.1
  have hPrereq := hPair.2
  simp only [Bool.not_eq_false'] at hPrereq
  have hBase := hBaseEq
  simp only [Bool.or_eq_false_iff, Bool.not_eq_false'] at hBase
  rcases hBase with ⟨⟨⟨⟨⟨⟨⟨⟨⟨_, _⟩, _⟩, hNoWs⟩, _⟩, _⟩, _⟩, _⟩, hWidR⟩, hWidT⟩
  have hReachCert : ∀ ch,
      (match ch with
       | .runtime => computeReachability g .runtime (changed.filter (fun p => g.modules.contains p)) fuel
       | .typecheck => computeReachability g .typecheck (changed.filter (fun p => g.modules.contains p)) fuel).closed = true ∧
      isReachabilityClosed g ch (changed.filter (fun p => g.modules.contains p))
        (match ch with
         | .runtime => computeReachability g .runtime (changed.filter (fun p => g.modules.contains p)) fuel
         | .typecheck => computeReachability g .typecheck (changed.filter (fun p => g.modules.contains p)) fuel) = true := by
    intro ch
    cases ch with
    | runtime =>
        cases computeReachability_sound g .runtime (changed.filter (fun p => g.modules.contains p)) fuel with
        | inl h => exact h
        | inr hWs =>
            rcases hWs with ⟨u, hu, hScope⟩
            have hAny : (computeReachability g .runtime (changed.filter (fun p => g.modules.contains p)) fuel).uncertainties.any
                (fun x => x.scope == .wholeWorkspace) = true :=
              List.any_eq_true.mpr ⟨u, hu, by simp [hScope]⟩
            rw [hNoWs.1] at hAny
            cases hAny
    | typecheck =>
        cases computeReachability_sound g .typecheck (changed.filter (fun p => g.modules.contains p)) fuel with
        | inl h => exact h
        | inr hWs =>
            rcases hWs with ⟨u, hu, hScope⟩
            have hAny : (computeReachability g .typecheck (changed.filter (fun p => g.modules.contains p)) fuel).uncertainties.any
                (fun x => x.scope == .wholeWorkspace) = true :=
              List.any_eq_true.mpr ⟨u, hu, by simp [hScope]⟩
            rw [hNoWs.2] at hAny
            cases hAny
  refine ⟨hBaseEq, ?_, ?_, hPrereq⟩
  · intro ch
    unfold GraphPlanState.reachFor
    exact hReachCert ch
  · intro ch
    unfold GraphPlanState.widenedFor
    cases ch
    · exact hWidR
    · exact hWidT

private theorem reachFor_eq_computeReachability
    (m : Manifest) (g : DepGraph) (changed : List ModuleId) (reqFull : Bool) (fuel : Nat)
    (ch : AnalysisChannel) :
    (computeGraphPlanState m g changed reqFull fuel).reachFor ch =
      computeReachability g ch (changed.filter (fun p => g.modules.contains p)) fuel := by
  cases ch <;> rfl

private theorem graph_not_full_mod_exact_iff
    {m : Manifest} {g : DepGraph} {changed : List ModuleId} {reqFull : Bool} {fuel : Nat}
    (hNotFull : (computeGraphPlanState m g changed reqFull fuel).finalFull = false)
    (ch : AnalysisChannel) :
    ∀ x, x ∈ ((computeGraphPlanState m g changed reqFull fuel).reachFor ch).paths ↔
      ImpactedModule g ch (changed.filter (fun p => g.modules.contains p)) x := by
  have ⟨_, hReachAll, _, _⟩ := graph_not_full_implies_closed hNotFull
  have hClosed : (computeReachability g ch (changed.filter (fun p => g.modules.contains p)) fuel).closed = true := by
    rw [← reachFor_eq_computeReachability m g changed reqFull fuel ch]
    exact (hReachAll ch).1
  intro x
  rw [reachFor_eq_computeReachability m g changed reqFull fuel ch]
  exact (computeReachability_exact_iff hClosed).2.1 x

-- ============================================================================
-- PART A: Machine-Checked SOUNDNESS Theorems (Never Miss a Broken Test)
-- ============================================================================

/-- Theorem 1 (Prerequisite Closure): whenever a task is selected, all its declared prerequisites are selected. -/
theorem buildPlan_prereq_closed
    (m : Manifest) (g : Option DepGraph) (changed : List ModuleId)
    (reqFull : Bool) (fuel : Nat)
    {t : TaskSpec} {dep : TaskId}
    (ht : t ∈ m.tasks)
    (hSel : t.id ∈ (buildPlan m g changed reqFull fuel).selectedTasks)
    (hDep : dep ∈ t.dependsOn)
    (hDepValid : ∃ td ∈ m.tasks, td.id = dep) :
    dep ∈ (buildPlan m g changed reqFull fuel).selectedTasks := by
  unfold buildPlan at hSel ⊢
  cases g with
  | none =>
      dsimp only at hSel ⊢
      let ownedChanged := changed.filterMap m.ownerOf
      let hasUnownedChanged := changed.any (fun p => (m.ownerOf p).isNone)
      let widened := propagateDependents m ownedChanged fuel
      let full := reqFull || hasUnownedChanged || !isDependentsClosed m widened
      let baseSelected :=
        if full then m.tasks.map (·.id)
        else
          (m.tasks.filter fun t =>
            match t.impact with
            | .always => true
            | .changedFiles owned => changed.any (fun p => owned.contains p)
            | .project => widened.contains t.project
            | .reachability => widened.contains t.project).map (·.id)
      let selected := propagatePrereqs m baseSelected fuel
      change t.id ∈ (if (full || !isPrereqsClosed m selected) = true then m.tasks.map (·.id) else selected) at hSel
      change dep ∈ (if (full || !isPrereqsClosed m selected) = true then m.tasks.map (·.id) else selected)
      cases hFinal : (full || !isPrereqsClosed m selected)
      · simp only [hFinal, Bool.false_eq_true, ↓reduceIte] at hSel ⊢
        have hPrereq : isPrereqsClosed m selected = true := by
          simpa using (Bool.or_eq_false_iff.mp hFinal).2
        unfold isPrereqsClosed at hPrereq
        have htClosed := List.all_eq_true.mp hPrereq t ht
        have hSelBool := contains_of_mem hSel
        simp only [hSelBool, Bool.not_true, Bool.false_or] at htClosed
        exact mem_of_contains (List.all_eq_true.mp htClosed dep hDep)
      · simp only [↓reduceIte]
        rcases hDepValid with ⟨td, htd, htdId⟩
        exact htdId ▸ List.mem_map_of_mem htd
  | some graph =>
      dsimp only at hSel ⊢
      cases hFull : (computeGraphPlanState m graph changed reqFull fuel).finalFull
      · have ⟨_, _, _, hPrereq⟩ := graph_not_full_implies_closed hFull
        have hSelEq := graph_finalSelected_eq_of_false hFull
        rw [hSelEq] at hSel ⊢
        unfold isPrereqsClosed at hPrereq
        have htClosed := List.all_eq_true.mp hPrereq t ht
        have hSelBool := contains_of_mem hSel
        simp only [hSelBool, Bool.not_true, Bool.false_or] at htClosed
        exact mem_of_contains (List.all_eq_true.mp htClosed dep hDep)
      · have hSelEq := graph_finalSelected_eq_of_true hFull
        rw [hSelEq]
        rcases hDepValid with ⟨td, htd, htdId⟩
        exact htdId ▸ List.mem_map_of_mem htd

/-- Theorem 2 (No False Task Skips): any module impacted on `t.channel` selects every `reachability` task of its owner. -/
theorem no_false_task_skips
    (m : Manifest) (g : DepGraph) (changed : List ModuleId)
    (reqFull : Bool) (fuel : Nat)
    {mod : ModuleId} {p : ProjectId} {t : TaskSpec}
    (hImp : ImpactedModule g t.channel (changed.filter (fun x => g.modules.contains x)) mod)
    (hOwner : m.ownerOf mod = some p)
    (ht : t ∈ m.tasks)
    (htProj : t.project = p)
    (htMode : t.impact = .reachability) :
    t.id ∈ (buildPlan m (some g) changed reqFull fuel).selectedTasks := by
  unfold buildPlan
  dsimp only
  cases hFull : (computeGraphPlanState m g changed reqFull fuel).finalFull
  · have ⟨hBaseFalse, hReachAll, _, _⟩ := graph_not_full_implies_closed hFull
    have hModReached : mod ∈ ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths :=
      closed_captures_module_impact (hReachAll t.channel).2 hImp
    have hOwnerMem : p ∈ ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths.filterMap m.ownerOf :=
      List.mem_filterMap.mpr ⟨mod, hModReached, hOwner⟩
    have hProjHit : ((computeGraphPlanState m g changed reqFull fuel).reachProjectsFor t.channel).contains p = true := by
      cases hCh : t.channel <;>
        (rw [hCh] at hOwnerMem
         unfold GraphPlanState.reachFor at hOwnerMem
         unfold GraphPlanState.reachProjectsFor
         dsimp only at hOwnerMem ⊢
         exact contains_of_mem (mem_insertMany_left hOwnerMem))
    rw [graph_finalSelected_eq_of_false hFull]
    unfold computeGraphPlanState at hBaseFalse hProjHit ⊢
    dsimp only at hBaseFalse hProjHit ⊢
    apply mem_propagatePrereqs_of_mem
    simp only [hBaseFalse, Bool.false_eq_true, ↓reduceIte]
    apply List.mem_map_of_mem
    refine List.mem_filter.mpr ⟨ht, ?_⟩
    simp only [htMode, htProj]
    cases hCh : t.channel <;>
      (simp only [GraphPlanState.reachProjectsFor, hCh] at hProjHit ⊢
       simp only [hProjHit, Bool.or_true])
  · rw [graph_finalSelected_eq_of_true hFull]
    exact List.mem_map_of_mem ht

/-- Theorem 3 (No False Test-File Skips): an impacted test file `f ∈ t.testFiles` is NEVER skipped! -/
theorem no_false_file_skips
    (m : Manifest) (g : DepGraph) (changed : List ModuleId)
    (reqFull : Bool) (fuel : Nat)
    {t : TaskSpec} {f : ModuleId}
    (ht : t ∈ m.tasks)
    (htMode : t.impact = .reachability)
    (hfTask : f ∈ t.testFiles)
    (hfOwner : m.ownerOf f = some t.project)
    (hfImp : ImpactedModule g t.channel (changed.filter (fun x => g.modules.contains x)) f) :
    let scope := (buildPlan m (some g) changed reqFull fuel).taskScope t
    scope = .allTests ∨ ∃ fs, scope = .subset fs ∧ f ∈ fs := by
  have hSel : t.id ∈ (buildPlan m (some g) changed reqFull fuel).selectedTasks :=
    no_false_task_skips m g changed reqFull fuel hfImp hfOwner ht rfl htMode
  unfold buildPlan at hSel ⊢
  dsimp only at hSel ⊢
  cases hFull : (computeGraphPlanState m g changed reqFull fuel).finalFull
  · have ⟨_, hReachAll, _, _⟩ := graph_not_full_implies_closed hFull
    have hSelBool := contains_of_mem hSel
    simp only [Bool.false_eq_true, ↓reduceIte, hSelBool, Bool.not_true, htMode]
    split
    · left; rfl
    · split
      · left; rfl
      · split
        · left; rfl
        · have hfReached : f ∈ ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths :=
            closed_captures_module_impact (hReachAll t.channel).2 hfImp
          have hfInHit : f ∈ t.testFiles.filter (fun x => ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths.contains x) :=
            List.mem_filter.mpr ⟨hfTask, contains_of_mem hfReached⟩
          have hNotEmpty : (t.testFiles.filter (fun x => ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths.contains x)).isEmpty = false := by
            cases hL : t.testFiles.filter (fun x => ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths.contains x) with
            | nil => rw [hL] at hfInHit; cases hfInHit
            | cons _ _ => rfl
          simp only [hNotEmpty, Bool.false_eq_true, ↓reduceIte]
          right
          exact ⟨_, rfl, hfInHit⟩
  · left
    simp only [↓reduceIte]

/-- Theorem 4 (Uncertainty Always Widens): triggered uncertainty widens owner + transitive `fallbackDeps` to `allTests`. -/
theorem uncertainty_widens_to_all_tests
    (m : Manifest) (g : DepGraph) (changed : List ModuleId)
    (reqFull : Bool) (fuel : Nat)
    {u : GraphUncertainty} {p q : ProjectId} {t : TaskSpec}
    (hTrig : TriggeredUncertainty g t.channel (changed.filter (fun x => g.modules.contains x)) u)
    (hOwner : m.ownerOf u.path = some p)
    (hDep : TransitiveFallbackDep m p q)
    (hAllProj : ∀ x, TransitiveFallbackDep m p x → x ∈ m.projects)
    (ht : t ∈ m.tasks)
    (htProj : t.project = q)
    (htMode : t.impact = .reachability) :
    (buildPlan m (some g) changed reqFull fuel).taskScope t = .allTests := by
  unfold buildPlan
  dsimp only
  cases hFull : (computeGraphPlanState m g changed reqFull fuel).finalFull
  · have ⟨hBaseFalse, hReachAll, hWidAll, _⟩ := graph_not_full_implies_closed hFull
    have huMem : u ∈ ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).uncertainties :=
      closed_captures_triggered_uncertainty (hReachAll t.channel).2 hTrig
    have hpInWidened : p ∈ (computeGraphPlanState m g changed reqFull fuel).widenedFor t.channel := by
      have hpUnc : p ∈ ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).uncertainties.filterMap
          (fun x => m.ownerOf x.path) :=
        List.mem_filterMap.mpr ⟨u, huMem, hOwner⟩
      cases hCh : t.channel <;>
        (rw [hCh] at hpUnc
         unfold GraphPlanState.reachFor at hpUnc
         unfold GraphPlanState.widenedFor
         unfold computeGraphPlanState at hpUnc ⊢
         dsimp only at hpUnc ⊢
         exact mem_propagateDependents_of_mem fuel (mem_insertMany_right hpUnc))
    have hqInWidened : q ∈ (computeGraphPlanState m g changed reqFull fuel).widenedFor t.channel :=
      closed_dependents_transitive (hWidAll t.channel) hpInWidened hDep hAllProj
    have htInFinal : t.id ∈ (computeGraphPlanState m g changed reqFull fuel).finalSelected := by
      rw [graph_finalSelected_eq_of_false hFull]
      have hProjHit : ((computeGraphPlanState m g changed reqFull fuel).reachProjectsFor t.channel).contains q = true := by
        cases hCh : t.channel <;>
          (rw [hCh] at hqInWidened
           unfold GraphPlanState.widenedFor at hqInWidened
           unfold GraphPlanState.reachProjectsFor
           dsimp only at hqInWidened ⊢
           exact contains_of_mem (mem_insertMany_right hqInWidened))
      unfold computeGraphPlanState at hBaseFalse hProjHit ⊢
      dsimp only at hBaseFalse hProjHit ⊢
      apply mem_propagatePrereqs_of_mem
      simp only [hBaseFalse, Bool.false_eq_true, ↓reduceIte]
      apply List.mem_map_of_mem
      refine List.mem_filter.mpr ⟨ht, ?_⟩
      simp only [htMode, htProj]
      cases hCh : t.channel <;>
        (simp only [GraphPlanState.reachProjectsFor, hCh] at hProjHit ⊢
         simp only [hProjHit, Bool.or_true])
    have hSelBool := contains_of_mem htInFinal
    have hWidBool := contains_of_mem hqInWidened
    simp only [Bool.false_eq_true, ↓reduceIte, hSelBool, Bool.not_true, htMode, htProj, hWidBool]
  · simp only [↓reduceIte]

/-- Theorem 5 (Unowned Changed Path Forces Full Fallback). -/
theorem unowned_changed_forces_full_fallback
    (m : Manifest) (g : Option DepGraph) (changed : List ModuleId)
    (reqFull : Bool) (fuel : Nat)
    {p : ModuleId} (hp : p ∈ changed) (hNone : m.ownerOf p = none)
    (t : TaskSpec) :
    (buildPlan m g changed reqFull fuel).fullFallback = true ∧
    (buildPlan m g changed reqFull fuel).taskScope t = .allTests := by
  have hAny : changed.any (fun x => (m.ownerOf x).isNone) = true :=
    List.any_eq_true.mpr ⟨p, hp, by simp [hNone]⟩
  unfold buildPlan
  cases g with
  | none =>
      dsimp only
      simp [hAny]
  | some graph =>
      dsimp only
      have hFinalTrue : (computeGraphPlanState m graph changed reqFull fuel).finalFull = true := by
        unfold computeGraphPlanState
        dsimp only
        simp [hAny]
      simp [hFinalTrue]

-- ============================================================================
-- PART B: Machine-Checked PRECISION Theorems (NEVER Run Unaffected Tests!)
-- ============================================================================

/--
Theorem 6 (EXACT `↔` File-Level Selection):
Under clean evidence (no full fallback, task project un-widened, no declared asset of `t`
changed, and `t.testFiles` enumerated):
- If ANY test file `f ∈ t.testFiles` is impacted, `taskScope t = .subset fs` where
  `∀ f, f ∈ fs ↔ (f ∈ t.testFiles ∧ ImpactedModule g t.channel modChanged f)` —
  EXACT mathematical equality (not one missing, not one extra!).
- If ZERO test files in `t.testFiles` are impacted, `taskScope t = .skipProvenUnaffected`!
-/
theorem exact_file_subset_iff
    (m : Manifest) (g : DepGraph) (changed : List ModuleId)
    (reqFull : Bool) (fuel : Nat)
    {t : TaskSpec}
    (ht : t ∈ m.tasks)
    (htMode : t.impact = .reachability)
    (htEnum : t.testFiles ≠ [])
    (hAllOwned : ∀ f ∈ t.testFiles, m.ownerOf f = some t.project)
    (hNotFull : (buildPlan m (some g) changed reqFull fuel).fullFallback = false)
    (hNotWidened : t.project ∉ (buildPlan m (some g) changed reqFull fuel).widenedProjects t.channel)
    (hNoAsset : ∀ p ∈ changed, p ∉ t.assetPaths) :
    let modChanged := changed.filter (fun x => g.modules.contains x)
    let scope := (buildPlan m (some g) changed reqFull fuel).taskScope t
    ((∃ f ∈ t.testFiles, ImpactedModule g t.channel modChanged f) →
      ∃ fs, scope = .subset fs ∧
        ∀ f, f ∈ fs ↔ (f ∈ t.testFiles ∧ ImpactedModule g t.channel modChanged f)) ∧
    ((∀ f ∈ t.testFiles, ¬ ImpactedModule g t.channel modChanged f) →
      scope = .skipProvenUnaffected) := by
  have hFullFalse : (computeGraphPlanState m g changed reqFull fuel).finalFull = false := hNotFull
  have hModExact := graph_not_full_mod_exact_iff hFullFalse t.channel
  have hWidFalse : ((computeGraphPlanState m g changed reqFull fuel).widenedFor t.channel).contains t.project = false := by
    cases hW : ((computeGraphPlanState m g changed reqFull fuel).widenedFor t.channel).contains t.project
    · rfl
    · exact False.elim (hNotWidened (mem_of_contains hW))
  have hAssetFalse : changed.any (fun p => t.assetPaths.contains p) = false := by
    cases hA : changed.any (fun p => t.assetPaths.contains p)
    · rfl
    · rcases List.any_eq_true.mp hA with ⟨p, hpCh, hpAss⟩
      exact False.elim (hNoAsset p hpCh (mem_of_contains hpAss))
  have hEnumFalse : t.testFiles.isEmpty = false := by
    cases hL : t.testFiles with
    | nil => exact False.elim (htEnum hL)
    | cons _ _ => rfl
  constructor
  · rintro ⟨f0, hf0Task, hf0Imp⟩
    have hSel : t.id ∈ (buildPlan m (some g) changed reqFull fuel).selectedTasks :=
      no_false_task_skips m g changed reqFull fuel hf0Imp (hAllOwned f0 hf0Task) ht rfl htMode
    have hSelBool : (computeGraphPlanState m g changed reqFull fuel).finalSelected.contains t.id = true :=
      contains_of_mem hSel
    have hf0Hit : f0 ∈ t.testFiles.filter
        (fun x => ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths.contains x) :=
      List.mem_filter.mpr ⟨hf0Task, contains_of_mem ((hModExact f0).mpr hf0Imp)⟩
    have hHitNotEmpty : (t.testFiles.filter
        (fun x => ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths.contains x)).isEmpty = false := by
      cases hL : t.testFiles.filter
          (fun x => ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths.contains x) with
      | nil => rw [hL] at hf0Hit; cases hf0Hit
      | cons _ _ => rfl
    refine ⟨t.testFiles.filter
      (fun x => ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths.contains x), ?_, ?_⟩
    · unfold buildPlan
      dsimp only
      simp only [hFullFalse, Bool.false_eq_true, ↓reduceIte, hSelBool, Bool.not_true, htMode,
        hWidFalse, hAssetFalse, hEnumFalse, hHitNotEmpty]
    · intro f
      rw [List.mem_filter, List.elem_iff, hModExact f]
  · intro hNoneImp
    unfold buildPlan
    dsimp only
    simp only [hFullFalse, Bool.false_eq_true, ↓reduceIte]
    cases hSel : (computeGraphPlanState m g changed reqFull fuel).finalSelected.contains t.id
    · simp only [Bool.not_false, ↓reduceIte]
    · simp only [Bool.not_true, Bool.false_eq_true, ↓reduceIte, htMode, hWidFalse, hAssetFalse, hEnumFalse]
      have hHitEmpty : (t.testFiles.filter
          (fun x => ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths.contains x)).isEmpty = true := by
        cases hL : t.testFiles.filter
            (fun x => ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths.contains x) with
        | nil => rfl
        | cons hd _ =>
            have hMem : hd ∈ t.testFiles.filter
                (fun x => ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths.contains x) := by
              rw [hL]; exact List.mem_cons_self
            rcases List.mem_filter.mp hMem with ⟨hdTask, hdPath⟩
            exact False.elim (hNoneImp hd hdTask ((hModExact hd).mp (mem_of_contains hdPath)))
      simp only [hHitEmpty, ↓reduceIte]

/--
Theorem 7 (No Spurious Test-File Runs):
Whenever `buildPlan` chooses `.subset fs` (and `fullFallback = false`), EVERY file `f ∈ fs`
is genuinely impacted AND every unaffected file `f ∈ t.testFiles` is guaranteed excluded.
-/
theorem no_spurious_file_runs
    (m : Manifest) (g : DepGraph) (changed : List ModuleId)
    (reqFull : Bool) (fuel : Nat)
    {t : TaskSpec} {fs : List ModuleId}
    (hNotFull : (buildPlan m (some g) changed reqFull fuel).fullFallback = false)
    (hSub : (buildPlan m (some g) changed reqFull fuel).taskScope t = .subset fs) :
    let modChanged := changed.filter (fun x => g.modules.contains x)
    (∀ f ∈ fs, ImpactedModule g t.channel modChanged f) ∧
    (∀ f ∈ t.testFiles, ¬ ImpactedModule g t.channel modChanged f → f ∉ fs) := by
  have hFullFalse : (computeGraphPlanState m g changed reqFull fuel).finalFull = false := hNotFull
  have hModExact := graph_not_full_mod_exact_iff hFullFalse t.channel
  unfold buildPlan at hSub
  dsimp only at hSub
  simp only [hFullFalse, Bool.false_eq_true, ↓reduceIte] at hSub
  split at hSub
  · cases hSub
  · cases htMode : t.impact with
    | always => simp [htMode] at hSub
    | changedFiles _ => simp [htMode] at hSub
    | project => simp [htMode] at hSub
    | reachability =>
        simp only [htMode] at hSub
        split at hSub
        · cases hSub
        · split at hSub
          · cases hSub
          · split at hSub
            · cases hSub
            · split at hSub
              · cases hSub
              · injection hSub with hFsEq
                subst hFsEq
                constructor
                · intro f hf
                  rcases List.mem_filter.mp hf with ⟨_, hfReach⟩
                  exact (hModExact f).mp (mem_of_contains hfReach)
                · intro f _ hNotImp hfIn
                  rcases List.mem_filter.mp hfIn with ⟨_, hfReach⟩
                  exact hNotImp ((hModExact f).mp (mem_of_contains hfReach))

/--
Theorem 8 (No Spurious Task Runs):
Under clean evidence (`fullFallback = false`, `t.impact = .reachability`, `t.project` un-widened,
no declared asset of `t` changed, `t.project` owns NO impacted module, and `t.id` is NOT a
transitive prerequisite of any base-selected task), `t` is GUARANTEED skipped (`skipProvenUnaffected`).
-/
theorem no_spurious_task_runs
    (m : Manifest) (g : DepGraph) (changed : List ModuleId)
    (reqFull : Bool) (fuel : Nat)
    {t : TaskSpec}
    (htMode : t.impact = .reachability)
    (hUniqueId : ∀ other ∈ m.tasks, other.id = t.id → other = t)
    (hNotFull : (buildPlan m (some g) changed reqFull fuel).fullFallback = false)
    (hNotWidened : t.project ∉ (buildPlan m (some g) changed reqFull fuel).widenedProjects t.channel)
    (hNoAsset : ∀ p ∈ changed, p ∉ t.assetPaths)
    (hNoImpInProj : ∀ mod, m.ownerOf mod = some t.project →
      ¬ ImpactedModule g t.channel (changed.filter (fun p => g.modules.contains p)) mod)
    (hNotPrereqOfSelected :
      ∀ s ∈ (computeGraphPlanState m g changed reqFull fuel).baseSelected,
        s ≠ t.id → ¬ TransitiveTaskPrereq m s t.id) :
    t.id ∉ (buildPlan m (some g) changed reqFull fuel).selectedTasks ∧
    (buildPlan m (some g) changed reqFull fuel).taskScope t = .skipProvenUnaffected := by
  have hFullFalse : (computeGraphPlanState m g changed reqFull fuel).finalFull = false := hNotFull
  have ⟨hBaseFalse, _, _, _⟩ := graph_not_full_implies_closed hFullFalse
  have hModExact := graph_not_full_mod_exact_iff hFullFalse t.channel
  have hNotInBase : t.id ∉ (computeGraphPlanState m g changed reqFull fuel).baseSelected := by
    intro hIn
    unfold computeGraphPlanState at hBaseFalse hIn
    dsimp only at hBaseFalse hIn
    simp only [hBaseFalse, Bool.false_eq_true, ↓reduceIte] at hIn
    rcases List.mem_map.mp hIn with ⟨other, hOtherFilt, hOtherId⟩
    rcases List.mem_filter.mp hOtherFilt with ⟨hOtherMem, hPred⟩
    have hEq : other = t := hUniqueId other hOtherMem hOtherId
    subst other
    simp only [htMode] at hPred
    rcases Bool.or_eq_true_iff.mp hPred with hAss | hProj
    · rcases List.any_eq_true.mp hAss with ⟨p, hpCh, hpAss⟩
      exact hNoAsset p hpCh (mem_of_contains hpAss)
    · have hProjMem : t.project ∈ (computeGraphPlanState m g changed reqFull fuel).reachProjectsFor t.channel := by
        cases hCh : t.channel <;>
          (simp only [hCh] at hProj
           unfold GraphPlanState.reachProjectsFor computeGraphPlanState
           dsimp only
           exact mem_of_contains hProj)
      have hOr : t.project ∈ ((computeGraphPlanState m g changed reqFull fuel).reachFor t.channel).paths.filterMap m.ownerOf ∨
          t.project ∈ (computeGraphPlanState m g changed reqFull fuel).widenedFor t.channel := by
        cases hCh : t.channel <;>
          (rw [hCh] at hProjMem
           unfold GraphPlanState.reachProjectsFor at hProjMem
           unfold GraphPlanState.reachFor GraphPlanState.widenedFor
           unfold computeGraphPlanState at hProjMem ⊢
           dsimp only at hProjMem ⊢
           exact mem_insertMany_iff.mp hProjMem)
      cases hOr with
      | inl hReachProj =>
          rcases List.mem_filterMap.mp hReachProj with ⟨mod, hModPath, hModOwn⟩
          exact hNoImpInProj mod hModOwn ((hModExact mod).mp hModPath)
      | inr hWid =>
          exact hNotWidened hWid
  have hNotSel : t.id ∉ (buildPlan m (some g) changed reqFull fuel).selectedTasks := by
    unfold buildPlan
    dsimp only
    rw [graph_finalSelected_eq_of_false hFullFalse]
    intro hIn
    rcases propagatePrereqs_precise fuel t.id hIn with ⟨s, hsBase, hPath⟩
    by_cases hEq : s = t.id
    · subst hEq; exact hNotInBase hsBase
    · exact hNotPrereqOfSelected s hsBase hEq hPath
  have hSelFalse : (computeGraphPlanState m g changed reqFull fuel).finalSelected.contains t.id = false := by
    cases hS : (computeGraphPlanState m g changed reqFull fuel).finalSelected.contains t.id
    · rfl
    · exact False.elim (hNotSel (mem_of_contains hS))
  refine ⟨hNotSel, ?_⟩
  unfold buildPlan
  dsimp only
  simp only [hFullFalse, Bool.false_eq_true, ↓reduceIte, hSelFalse, Bool.not_false]

/--
Theorem 9 (Comment / Formatting-Only Edits Run ZERO Tests):
If every changed file is a proven comment/formatting-only edit (`complete = true`,
`semanticChange = false`, `exports = []`), then NO symbol and NO module is impacted on any
channel — so every clean, enumerated `reachability` task is proven to get `skipProvenUnaffected`!
-/
theorem comment_only_edit_has_no_impact
    {g : DepGraph} {ch : AnalysisChannel} {changed : List ModuleId}
    (hCommentOnly : ∀ m ∈ changed,
      ∃ c, g.changeOf m = some c ∧ c.complete = true ∧ c.semanticChange = false) :
    (∀ m s, ¬ ImpactedSymbol g ch changed m s) ∧
    (∀ m, ¬ ImpactedModule g ch changed m) := by
  have hNoSym : ∀ m s, ¬ ImpactedSymbol g ch changed m s := by
    intro m s hImp
    induction hImp with
    | @seed m c s hm hch _ hsem _ =>
        rcases hCommentOnly m hm with ⟨c', hc', _, hsemFalse⟩
        rw [hc'] at hch
        cases hch
        rw [hsemFalse] at hsem
        cases hsem
    | reexportAll _ _ _ ih => exact ih
    | namedRuntime _ _ _ _ ih => exact ih
    | namespaceTracked _ _ _ _ ih => exact ih
    | typeOnlyCheck _ _ _ _ _ ih => exact ih
    | bareRuntime _ _ _ ih => exact ih
    | boundedDynamic _ _ _ ih => exact ih
  have hNoEval : ∀ m, ¬ ImpactedModuleEval g changed m := by
    intro m hEval
    induction hEval with
    | @seed m c hm hch _ hsem _ =>
        rcases hCommentOnly m hm with ⟨c', hc', _, hsemFalse⟩
        rw [hc'] at hch
        cases hch
        rw [hsemFalse] at hsem
        cases hsem
    | runtimeImporter _ _ _ ih => exact ih
  refine ⟨hNoSym, ?_⟩
  intro m hMod
  cases hMod with
  | @changedSemantic c hm hch _ hsem =>
      rcases hCommentOnly m hm with ⟨c', hc', _, hsemFalse⟩
      rw [hc'] at hch
      cases hch
      rw [hsemFalse] at hsem
      cases hsem
  | @changedUnattributed hm hbad =>
      rcases hCommentOnly m hm with ⟨c', hc', hcompTrue, _⟩
      rw [hc'] at hbad
      simp [hcompTrue] at hbad
  | @fromSymbol s hSym => exact hNoSym m s hSym
  | @fromModuleEval hEval => exact hNoEval m hEval
  | @namedImporter tgt _ s hSym _ _ => exact hNoSym tgt s hSym
  | @namespaceTrackedImporter tgt _ s hSym _ _ => exact hNoSym tgt s hSym
  | @typeOnlyImporter tgt _ s _ hSym _ _ => exact hNoSym tgt s hSym
  | @bareImporter tgt s hSym _ => exact hNoSym tgt s hSym
  | @boundedDynamicImporter tgt s hSym _ => exact hNoSym tgt s hSym

theorem comment_only_edit_runs_zero_tests
    (m : Manifest) (g : DepGraph) (changed : List ModuleId)
    (reqFull : Bool) (fuel : Nat)
    {t : TaskSpec}
    (ht : t ∈ m.tasks)
    (htMode : t.impact = .reachability)
    (htEnum : t.testFiles ≠ [])
    (hAllOwned : ∀ f ∈ t.testFiles, m.ownerOf f = some t.project)
    (hNotFull : (buildPlan m (some g) changed reqFull fuel).fullFallback = false)
    (hNotWidened : t.project ∉ (buildPlan m (some g) changed reqFull fuel).widenedProjects t.channel)
    (hNoAsset : ∀ p ∈ changed, p ∉ t.assetPaths)
    (hCommentOnly : ∀ x ∈ changed.filter (fun p => g.modules.contains p),
      ∃ c, g.changeOf x = some c ∧ c.complete = true ∧ c.semanticChange = false) :
    (buildPlan m (some g) changed reqFull fuel).taskScope t = .skipProvenUnaffected := by
  have ⟨_, hNoMod⟩ := comment_only_edit_has_no_impact (ch := t.channel) hCommentOnly
  exact (exact_file_subset_iff m g changed reqFull fuel ht htMode htEnum hAllOwned
    hNotFull hNotWidened hNoAsset).2 (fun f _ => hNoMod f)

/--
Theorem 10 (Module-Evaluation Side-Effect Soundness & Runtime Narrowing):
Any test file `f ∈ t.testFiles` that transitively loads a `moduleEvalChanged` module through
runtime edges (`ImpactedModuleEval`) is GUARANTEED never to be skipped by `buildPlan`, while
under clean `.subset fs` planning any `import type`-only (or unrelated) test file `u` stays excluded!
-/
theorem module_eval_change_selects_runtime_test
    (m : Manifest) (g : DepGraph) (changed : List ModuleId)
    (reqFull : Bool) (fuel : Nat)
    {t : TaskSpec} {f : ModuleId}
    (ht : t ∈ m.tasks)
    (htMode : t.impact = .reachability)
    (hfTask : f ∈ t.testFiles)
    (hfOwner : m.ownerOf f = some t.project)
    (hfEval : ImpactedModuleEval g (changed.filter (fun x => g.modules.contains x)) f) :
    let scope := (buildPlan m (some g) changed reqFull fuel).taskScope t
    scope = .allTests ∨ ∃ fs, scope = .subset fs ∧ f ∈ fs :=
  no_false_file_skips m g changed reqFull fuel ht htMode hfTask hfOwner
    (ImpactedModule.fromModuleEval hfEval)

theorem module_eval_type_only_test_stays_excluded_in_subset
    (m : Manifest) (g : DepGraph) (changed : List ModuleId)
    (reqFull : Bool) (fuel : Nat)
    {t : TaskSpec} {fs : List ModuleId} {typeOnlyTest : ModuleId}
    (htChan : t.channel = .runtime)
    (hErase : g.erasesTypeOnly = true)
    (hNotFull : (buildPlan m (some g) changed reqFull fuel).fullFallback = false)
    (hSub : (buildPlan m (some g) changed reqFull fuel).taskScope t = .subset fs)
    (huTask : typeOnlyTest ∈ t.testFiles)
    (huNotChanged : typeOnlyTest ∉ changed.filter (fun x => g.modules.contains x))
    (huOnlyType : ∀ e ∈ g.edges, e.source = typeOnlyTest → e.kind.isRuntime = false)
    (huNoDecl : ∀ u ∈ g.declaredUncertainties, u.path ≠ typeOnlyTest) :
    typeOnlyTest ∉ fs := by
  have ⟨_, hNotMod, _⟩ :=
    module_eval_erases_type_only_runtime hErase huNotChanged huOnlyType huNoDecl
  have ⟨_, hExcl⟩ := no_spurious_file_runs m g changed reqFull fuel hNotFull hSub
  rw [htChan] at hExcl
  exact hExcl typeOnlyTest huTask hNotMod

end DadTest
