import DadsAccess.Model
import DadsAccess.Semantics

/-!
# Dads Access Formal Proofs (`DadsAccess.Proofs`)

Machine-checked Lean 4 theorems (zero `sorry`, zero custom axioms) proving the
soundness of Dads's ReBAC semantics and compiler optimizations:

1. `expired_tuple_not_active` & `expired_tuple_absent_from_active`
2. `unknown_perm_fails_closed` & `unknown_perm_lookup_empty`
3. `throughAll_vacuous_fails_closed`
4. `per_relation_userset_shortcut_sound`
5. `forward_reverse_equiv` & `compileFilter_row_equiv`
6. `scope_columns_through_sound`, `scope_columns_anyOf_unless_sound`, & `multi_scope_columns_sound`
7. `resolve_filter_branch_pruning_sound` & `resolve_filter_empty_false`
8. `evalExprWith_monotone`, `stepPermVal_monotone`, `iterPermVal_ascending`,
   `iterPermVal_le_fixed_point`, & `iterPermVal_stabilizes`
9. `unless_dominance` & `unless_dominates_anyOf`
10. `revocation_no_escalation` & `revocation_check_no_escalation`
11. `namespace_isolation_check` & `namespace_isolation_lookup`
-/

namespace DadsAccess

/-! ## 1. Fail-closed expiration -/

theorem expired_tuple_not_active (now exp : Timestamp) (t : Tuple)
    (ht : t.expiresAt = some exp) (hexp : exp ≤ now) :
    tupleActive now t = false := by
  unfold tupleActive
  rw [ht]
  simp only [decide_eq_false_iff_not, Nat.not_lt]
  exact hexp

theorem expired_tuple_absent_from_active (store : List Tuple) (now exp : Timestamp)
    (t : Tuple) (ht : t.expiresAt = some exp) (hexp : exp ≤ now) :
    t ∉ activeTuples store now := by
  unfold activeTuples
  intro hmem
  rw [List.mem_filter] at hmem
  have hfalse := expired_tuple_not_active now exp t ht hexp
  rw [hfalse] at hmem
  exact Bool.noConfusion hmem.2

/-! ## 2. Fail-closed unknown permissions -/

theorem unknown_perm_fails_closed (m : AccessModel) (store : List Tuple)
    (now : Timestamp) (a : Actor) (fuel : Nat) (e : EntityName) (id : ObjId)
    (p : PermName) (hnone : m.findPerm e p = none) :
    evalPermFuel m store now a fuel e id p = false := by
  unfold evalPermFuel
  cases fuel with
  | zero => rfl
  | succ k =>
      simp only [iterPermVal, stepPermVal, hnone]

theorem unknown_perm_lookup_empty (m : AccessModel) (store : List Tuple)
    (now : Timestamp) (a : Actor) (e : EntityName) (p : PermName)
    (candidates : List ObjId) (hnone : m.findPerm e p = none) :
    lookupResourcesOver m store now a e p candidates = [] := by
  unfold lookupResourcesOver
  rw [List.filter_eq_nil_iff]
  intro id _
  unfold evalCheck
  rw [unknown_perm_fails_closed m store now a (defaultFuel m store) e id p hnone]
  decide

/-! ## 3. Non-vacuous `every()` (`throughAll`) fails closed -/

theorem throughAll_vacuous_fails_closed (store : List Tuple) (now : Timestamp)
    (a : Actor) (permVal : EntityName → ObjId → PermName → Bool)
    (e : EntityName) (id : ObjId) (rel : RelName) (targets : List ArrowTarget)
    (hempty : directEntityEdges store now e id rel = []) :
    evalExprWith store now a permVal e id (.throughAll rel targets) = false := by
  simp [evalExprWith, hempty]

/-! ## 4. Per-relation userset shortcut soundness -/

/--
When the tuple store satisfies schema validation (`StoreValid m store`) and
relation `(e, r)` declares no `subjectSet` targets (`RelationNoUserset m e r`),
direct primary-key membership (`directMember`) is 100% equivalent to full
recursive userset membership (`UsersetMember`).
-/
theorem per_relation_userset_shortcut_sound (m : AccessModel) (store : List Tuple)
    (now : Timestamp) (a : Actor) (e : EntityName) (id : ObjId) (r : RelName)
    (hvalid : StoreValid m store) (hno : RelationNoUserset m e r) :
    UsersetMember store now a e id r ↔ directMember store now a e id r = true := by
  constructor
  · intro hmem
    cases hmem with
    | direct hdir => exact hdir
    | step hex _ =>
        rcases hex with ⟨t, htActive, hkind, _, hrel, hsubj⟩
        have htMem : t ∈ store := (List.mem_filter.mp htActive).1
        rcases hvalid t htMem with ⟨rd, hfind, tgt, htgtMem, hmatch⟩
        rw [hkind, hrel] at hfind
        rw [hsubj] at hmatch
        cases tgt with
        | entity tk =>
            simp [Subject.matchesTarget] at hmatch
        | wildcard tk =>
            simp [Subject.matchesTarget] at hmatch
        | subjectSet tk tr =>
            exact False.elim (hno rd hfind (.subjectSet tk tr) htgtMem tk tr rfl)
  · intro hdir
    exact UsersetMember.direct hdir

/-! ## 5. Forward ↔ Reverse equivalence (`check` ≡ `lookupResources` ≡ `compileFilter`) -/

theorem forward_reverse_equiv (m : AccessModel) (store : List Tuple)
    (now : Timestamp) (a : Actor) (e : EntityName) (p : PermName)
    (candidates : List ObjId) (id : ObjId) (huniv : id ∈ candidates) :
    id ∈ lookupResourcesOver m store now a e p candidates ↔
      evalCheck m store now a e id p = true := by
  unfold lookupResourcesOver
  rw [List.mem_filter]
  exact ⟨fun h => h.2, fun h => ⟨huniv, h⟩⟩

theorem compileFilter_row_equiv {Row : Type} (rowId : Row → ObjId)
    (m : AccessModel) (store : List Tuple) (now : Timestamp) (a : Actor)
    (e : EntityName) (p : PermName) (table : List Row) :
    let candidates := table.map rowId
    let allowed := lookupResourcesOver m store now a e p candidates
    table.filter (fun row => allowed.contains (rowId row)) =
      table.filter (fun row => evalCheck m store now a e (rowId row) p) := by
  intro candidates allowed
  apply List.filter_congr
  intro row hrow
  have huniv : rowId row ∈ candidates := List.mem_map_of_mem hrow
  have hiff : allowed.contains (rowId row) = true ↔ evalCheck m store now a e (rowId row) p = true := by
    rw [List.contains_iff_mem]
    exact forward_reverse_equiv m store now a e p candidates (rowId row) huniv
  cases hc : allowed.contains (rowId row) <;> cases he : evalCheck m store now a e (rowId row) p
  · rfl
  · exfalso
    have := hiff.mpr he
    rw [hc] at this
    exact Bool.noConfusion this
  · exfalso
    have := hiff.mp hc
    rw [he] at this
    exact Bool.noConfusion this
  · rfl

/-! ## 6. `scopeColumns` rewrite soundness -/

/--
When `fk r` holds the unique active `rel` parent of `r` (`ScopeColumnConsistent`),
evaluating `.through rel [parentEntity#parentPerm]` is 100% equivalent to
checking `fk r ∈ lookupResourcesOver ... parentEntity parentPerm`.
-/
theorem scope_columns_through_sound (m : AccessModel) (store : List Tuple)
    (now : Timestamp) (a : Actor)
    (permVal : EntityName → ObjId → PermName → Bool)
    (childEntity : EntityName) (rel : RelName)
    (parentEntity : EntityName) (parentPerm : PermName)
    (parentUniverse : List ObjId) (fk : ObjId → ObjId) (r : ObjId)
    (hfk : ScopeColumnConsistent store now childEntity rel parentEntity fk)
    (huniv : fk r ∈ parentUniverse)
    (hval : permVal parentEntity (fk r) parentPerm =
      evalCheck m store now a parentEntity (fk r) parentPerm) :
    evalExprWith store now a permVal childEntity r
      (.through rel [{ entity := parentEntity, perm := parentPerm }]) =
    evalScopedThrough m store now a parentEntity parentPerm parentUniverse fk r := by
  unfold evalExprWith evalScopedThrough
  rw [hfk r]
  simp only [List.any_cons, List.any_nil, Bool.or_false, beq_self_eq_true, Bool.true_and, hval]
  have hiff :
      (lookupResourcesOver m store now a parentEntity parentPerm parentUniverse).contains (fk r) = true ↔
      evalCheck m store now a parentEntity (fk r) parentPerm = true := by
    rw [List.contains_iff_mem]
    exact forward_reverse_equiv m store now a parentEntity parentPerm parentUniverse (fk r) huniv
  cases h1 : evalCheck m store now a parentEntity (fk r) parentPerm <;>
    cases h2 : (lookupResourcesOver m store now a parentEntity parentPerm parentUniverse).contains (fk r)
  · rfl
  · exfalso; have := hiff.mp h2; rw [h1] at this; exact Bool.noConfusion this
  · exfalso; have := hiff.mpr h1; rw [h2] at this; exact Bool.noConfusion this
  · rfl

/--
Full `anyOf(parent.perm, directExpr).unless(banExpr)` scoped rewrite theorem:
pushing the parent arrow onto `fk r` while keeping `directExpr` and `banExpr`
on `r` yields the exact same decision.
-/
theorem scope_columns_anyOf_unless_sound (m : AccessModel) (store : List Tuple)
    (now : Timestamp) (a : Actor)
    (permVal : EntityName → ObjId → PermName → Bool)
    (childEntity : EntityName) (rel : RelName)
    (parentEntity : EntityName) (parentPerm : PermName)
    (parentUniverse : List ObjId) (fk : ObjId → ObjId) (r : ObjId)
    (directExpr banExpr : Expr)
    (hfk : ScopeColumnConsistent store now childEntity rel parentEntity fk)
    (huniv : fk r ∈ parentUniverse)
    (hval : permVal parentEntity (fk r) parentPerm =
      evalCheck m store now a parentEntity (fk r) parentPerm) :
    evalExprWith store now a permVal childEntity r
      (.exclude (.anyOf [.through rel [{ entity := parentEntity, perm := parentPerm }], directExpr]) banExpr) =
    ((evalScopedThrough m store now a parentEntity parentPerm parentUniverse fk r ||
      evalExprWith store now a permVal childEntity r directExpr) &&
     !(evalExprWith store now a permVal childEntity r banExpr)) := by
  have hthrough := scope_columns_through_sound m store now a permVal childEntity rel
    parentEntity parentPerm parentUniverse fk r hfk huniv hval
  simp only [evalExprWith, List.any_cons, List.any_nil, Bool.or_false] at hthrough ⊢
  rw [hthrough]

/-! ## 7. Branch-pruning `resolveFilter` soundness -/

private theorem evalBranchList_prune (branches : List ((ObjId → ObjId) × List ObjId))
    (r : ObjId) :
    evalBranchList (pruneEmptyBranches branches) r = evalBranchList branches r := by
  induction branches with
  | nil => rfl
  | cons hd tl ih =>
      rcases hd with ⟨col, ids⟩
      cases ids with
      | nil =>
          change evalBranchList (pruneEmptyBranches tl) r = (false || evalBranchList tl r)
          rw [ih]
          simp
      | cons x xs =>
          change (((x :: xs).contains (col r)) || evalBranchList (pruneEmptyBranches tl) r) =
            (((x :: xs).contains (col r)) || evalBranchList tl r)
          rw [ih]

theorem resolve_filter_branch_pruning_sound
    (includeBranches : List ((ObjId → ObjId) × List ObjId))
    (excludedIds : List ObjId) (r : ObjId) :
    evalResolvedFilter includeBranches excludedIds r =
      (evalBranchList includeBranches r && !(excludedIds.contains r)) := by
  unfold evalResolvedFilter
  dsimp only
  rw [evalBranchList_prune]
  cases hinc : (pruneEmptyBranches includeBranches).isEmpty with
  | true =>
      have hnil : pruneEmptyBranches includeBranches = [] := List.isEmpty_iff.mp hinc
      have hzero : evalBranchList includeBranches r = false := by
        rw [← evalBranchList_prune, hnil]
        rfl
      simp [hzero]
  | false =>
      cases hex : excludedIds.isEmpty with
      | true =>
          have hnil : excludedIds = [] := List.isEmpty_iff.mp hex
          simp [hnil]
      | false =>
          simp

theorem resolve_filter_empty_false
    (includeBranches : List ((ObjId → ObjId) × List ObjId))
    (excludedIds : List ObjId) (r : ObjId)
    (hempty : ∀ b ∈ includeBranches, b.2 = []) :
    evalResolvedFilter includeBranches excludedIds r = false := by
  rw [resolve_filter_branch_pruning_sound]
  have hzero : evalBranchList includeBranches r = false := by
    induction includeBranches with
    | nil => rfl
    | cons hd tl ih =>
        have hhd : hd.2 = [] := hempty hd (List.mem_cons_self ..)
        have htl : ∀ b ∈ tl, b.2 = [] := fun b hb => hempty b (List.mem_cons_of_mem hd hb)
        rcases hd with ⟨col, ids⟩
        simp only at hhd
        subst hhd
        change (false || evalBranchList tl r) = false
        rw [ih htl]
        rfl
  simp [hzero]

/-! ## 8. Monotonicity & Knaster-Tarski ascending chain for recursive policies -/

/-- Pointwise partial order on permission truth tables (`P ⊑ Q`). -/
def PermLe (P Q : EntityName → ObjId → PermName → Bool) : Prop :=
  ∀ e id p, P e id p = true → Q e id p = true

private theorem list_any_monotone {α : Type} {f g : α → Bool} {xs : List α}
    (hfg : ∀ x ∈ xs, f x = true → g x = true) :
    xs.any f = true → xs.any g = true := by
  intro h
  rw [List.any_eq_true] at h ⊢
  rcases h with ⟨x, hx, hfx⟩
  exact ⟨x, hx, hfg x hx hfx⟩

private theorem list_all_monotone {α : Type} {f g : α → Bool} {xs : List α}
    (hfg : ∀ x ∈ xs, f x = true → g x = true) :
    xs.all f = true → xs.all g = true := by
  intro h
  rw [List.all_eq_true] at h ⊢
  intro x hx
  exact hfg x hx (h x hx)

theorem evalExprWith_monotone (store : List Tuple) (now : Timestamp) (a : Actor)
    (P Q : EntityName → ObjId → PermName → Bool) (hPQ : PermLe P Q)
    (e : EntityName) (id : ObjId) :
    ∀ expr : Expr, expr.isMonotonic = true →
      evalExprWith store now a P e id expr = true →
      evalExprWith store now a Q e id expr = true
  | .rel _, _, h => by
      simp only [evalExprWith] at h ⊢
      exact h
  | .anyOf cs, hmono, h => by
      simp only [Expr.isMonotonic, List.all_eq_true] at hmono
      simp only [evalExprWith] at h ⊢
      exact list_any_monotone (fun c hc =>
        evalExprWith_monotone store now a P Q hPQ e id c (hmono c hc)) h
  | .allOf cs, hmono, h => by
      simp only [Expr.isMonotonic, List.all_eq_true] at hmono
      simp only [evalExprWith] at h ⊢
      exact list_all_monotone (fun c hc =>
        evalExprWith_monotone store now a P Q hPQ e id c (hmono c hc)) h
  | .exclude _ _, hmono, _ => by
      simp [Expr.isMonotonic] at hmono
  | .through rel targets, _, h => by
      simp only [evalExprWith] at h ⊢
      apply list_any_monotone _ h
      intro edge _ hedge
      apply list_any_monotone _ hedge
      intro tgt _ htgt
      simp only [Bool.and_eq_true] at htgt ⊢
      exact ⟨htgt.1, hPQ tgt.entity edge.2 tgt.perm htgt.2⟩
  | .throughAll rel targets, _, h => by
      simp only [evalExprWith, Bool.and_eq_true] at h ⊢
      refine ⟨h.1, ?_⟩
      apply list_all_monotone _ h.2
      intro edge _ hedge
      apply list_any_monotone _ hedge
      intro tgt _ htgt
      simp only [Bool.and_eq_true] at htgt ⊢
      exact ⟨htgt.1, hPQ tgt.entity edge.2 tgt.perm htgt.2⟩
termination_by expr => sizeOf expr

/-- A monotonic model has no negation (`exclude`) inside any permission definition. -/
def ModelMonotonic (m : AccessModel) : Prop :=
  ∀ d ∈ m.permissions, d.expr.isMonotonic = true

theorem stepPermVal_monotone (m : AccessModel) (store : List Tuple)
    (now : Timestamp) (a : Actor) (hmono : ModelMonotonic m)
    (P Q : EntityName → ObjId → PermName → Bool) (hPQ : PermLe P Q) :
    PermLe (stepPermVal m store now a P) (stepPermVal m store now a Q) := by
  intro e id p hP
  unfold stepPermVal at hP ⊢
  cases hfind : m.findPerm e p with
  | none =>
      rw [hfind] at hP
      exact Bool.noConfusion hP
  | some defn =>
      rw [hfind] at hP
      dsimp only at hP ⊢
      have hmem : defn ∈ m.permissions := List.mem_of_find?_eq_some hfind
      exact evalExprWith_monotone store now a P Q hPQ e id defn.expr (hmono defn hmem) hP

/--
Kleene ascending chain theorem: starting from `⊥`, `iterPermVal` grows
monotonically at every step (`iter k ⊑ iter (k + 1)`), guaranteeing convergence
to the unique least fixed point on any finite cyclic tuple graph.
-/
theorem iterPermVal_ascending (m : AccessModel) (store : List Tuple)
    (now : Timestamp) (a : Actor) (hmono : ModelMonotonic m) :
    ∀ k, PermLe (iterPermVal m store now a k) (iterPermVal m store now a (k + 1))
  | 0 => by
      intro e id p h
      exact Bool.noConfusion h
  | k + 1 =>
      stepPermVal_monotone m store now a hmono
        (iterPermVal m store now a k)
        (iterPermVal m store now a (k + 1))
        (iterPermVal_ascending m store now a hmono k)

/-- Monotonicity across any step count `k₁ ≤ k₂`. -/
theorem iterPermVal_monotone_fuel (m : AccessModel) (store : List Tuple)
    (now : Timestamp) (a : Actor) (hmono : ModelMonotonic m)
    {k₁ k₂ : Nat} (hle : k₁ ≤ k₂) :
    PermLe (iterPermVal m store now a k₁) (iterPermVal m store now a k₂) := by
  induction hle with
  | refl =>
      intro e id p h
      exact h
  | @step n _ ih =>
      intro e id p h
      exact iterPermVal_ascending m store now a hmono n e id p (ih e id p h)

/--
Least fixed-point theorem: for any pre-fixed point `F` of `stepPermVal`, every
Kleene iterate `iterPermVal ... k` is bounded above by `F`. Therefore any fixed
point reached by `iterPermVal` is the unique least fixed point (cycles never
self-justify).
-/
theorem iterPermVal_le_fixed_point (m : AccessModel) (store : List Tuple)
    (now : Timestamp) (a : Actor) (hmono : ModelMonotonic m)
    (F : EntityName → ObjId → PermName → Bool)
    (hpre : PermLe (stepPermVal m store now a F) F) :
    ∀ k, PermLe (iterPermVal m store now a k) F
  | 0 => by
      intro e id p h
      exact Bool.noConfusion h
  | k + 1 => by
      intro e id p h
      have hstep := stepPermVal_monotone m store now a hmono
        (iterPermVal m store now a k) F
        (iterPermVal_le_fixed_point m store now a hmono F hpre k)
        e id p h
      exact hpre e id p hstep

/--
Post-convergence stabilization: once `iterPermVal` reaches a fixed point at
round `k`, all subsequent rounds `k + n` yield the exact same valuation.
-/
theorem iterPermVal_stabilizes (m : AccessModel) (store : List Tuple)
    (now : Timestamp) (a : Actor) (k : Nat)
    (hfp : iterPermVal m store now a (k + 1) = iterPermVal m store now a k) :
    ∀ n, iterPermVal m store now a (k + n) = iterPermVal m store now a k
  | 0 => rfl
  | n + 1 => by
      change stepPermVal m store now a (iterPermVal m store now a (k + n)) =
        iterPermVal m store now a k
      rw [iterPermVal_stabilizes m store now a k hfp n]
      exact hfp

/-! ## 9. Explicit `.unless()` dominance (bans always win) -/

theorem unless_dominance (store : List Tuple) (now : Timestamp) (a : Actor)
    (permVal : EntityName → ObjId → PermName → Bool)
    (e : EntityName) (id : ObjId) (baseExpr banExpr : Expr)
    (hbanned : evalExprWith store now a permVal e id banExpr = true) :
    evalExprWith store now a permVal e id (.exclude baseExpr banExpr) = false := by
  simp [evalExprWith, hbanned]

theorem unless_dominates_anyOf (store : List Tuple) (now : Timestamp) (a : Actor)
    (permVal : EntityName → ObjId → PermName → Bool)
    (e : EntityName) (id : ObjId) (grantExprs : List Expr) (banExpr : Expr)
    (hbanned : evalExprWith store now a permVal e id banExpr = true) :
    evalExprWith store now a permVal e id (.exclude (.anyOf grantExprs) banExpr) = false :=
  unless_dominance store now a permVal e id (.anyOf grantExprs) banExpr hbanned

/-! ## 10. Multi-column `scopeColumns` rewrite soundness -/

/--
Generalization of `scope_columns_anyOf_unless_sound` to any number of parent
foreign-key `scopeColumns` combined with an arbitrary direct expression and
exclusion expression.
-/
theorem multi_scope_columns_sound (m : AccessModel) (store : List Tuple)
    (now : Timestamp) (a : Actor)
    (permVal : EntityName → ObjId → PermName → Bool)
    (childEntity : EntityName) (r : ObjId)
    (specs : List ScopeColumnSpec) (directExpr banExpr : Expr)
    (hspecs : ∀ s ∈ specs,
      ScopeColumnConsistent store now childEntity s.rel s.parentEntity s.fk ∧
      s.fk r ∈ s.parentUniverse ∧
      permVal s.parentEntity (s.fk r) s.parentPerm =
        evalCheck m store now a s.parentEntity (s.fk r) s.parentPerm) :
    evalExprWith store now a permVal childEntity r
      (.exclude
        (.anyOf (specs.map (fun s => .through s.rel [{ entity := s.parentEntity, perm := s.parentPerm }]) ++ [directExpr]))
        banExpr) =
    ((specs.any (fun s => evalScopedThrough m store now a s.parentEntity s.parentPerm s.parentUniverse s.fk r) ||
      evalExprWith store now a permVal childEntity r directExpr) &&
     !(evalExprWith store now a permVal childEntity r banExpr)) := by
  have hany :
      (specs.map (fun s => Expr.through s.rel [{ entity := s.parentEntity, perm := s.parentPerm }]) ++ [directExpr]).any
        (evalExprWith store now a permVal childEntity r) =
      (specs.any (fun s => evalScopedThrough m store now a s.parentEntity s.parentPerm s.parentUniverse s.fk r) ||
        evalExprWith store now a permVal childEntity r directExpr) := by
    induction specs with
    | nil => simp
    | cons hd tl ih =>
        have hhd := hspecs hd (List.mem_cons_self ..)
        have htl : ∀ s ∈ tl,
            ScopeColumnConsistent store now childEntity s.rel s.parentEntity s.fk ∧
            s.fk r ∈ s.parentUniverse ∧
            permVal s.parentEntity (s.fk r) s.parentPerm =
              evalCheck m store now a s.parentEntity (s.fk r) s.parentPerm :=
          fun s hs => hspecs s (List.mem_cons_of_mem hd hs)
        have hthrough := scope_columns_through_sound m store now a permVal childEntity
          hd.rel hd.parentEntity hd.parentPerm hd.parentUniverse hd.fk r
          hhd.1 hhd.2.1 hhd.2.2
        simp only [List.map_cons, List.cons_append, List.any_cons, hthrough, ih htl, Bool.or_assoc]
  simp only [evalExprWith, hany]

/-! ## 11. Revocation monotonicity (deleting tuples never escalates positive access) -/

/-- A positive model contains only monotonic, non-vacuous positive rules. -/
def ModelPositive (m : AccessModel) : Prop :=
  ∀ d ∈ m.permissions, d.expr.isPositive = true

private theorem expr_positive_implies_monotonic :
    ∀ expr : Expr, expr.isPositive = true → expr.isMonotonic = true
  | .rel _, _ => by simp [Expr.isMonotonic]
  | .anyOf cs, hpos => by
      simp only [Expr.isPositive, List.all_eq_true] at hpos
      simp only [Expr.isMonotonic, List.all_eq_true]
      intro c hc
      exact expr_positive_implies_monotonic c (hpos c hc)
  | .allOf cs, hpos => by
      simp only [Expr.isPositive, List.all_eq_true] at hpos
      simp only [Expr.isMonotonic, List.all_eq_true]
      intro c hc
      exact expr_positive_implies_monotonic c (hpos c hc)
  | .exclude _ _, hpos => by simp [Expr.isPositive] at hpos
  | .through _ _, _ => by simp [Expr.isMonotonic]
  | .throughAll _ _, hpos => by simp [Expr.isPositive] at hpos
termination_by expr => sizeOf expr

private theorem model_positive_implies_monotonic (m : AccessModel) (hpos : ModelPositive m) :
    ModelMonotonic m :=
  fun d hd => expr_positive_implies_monotonic d.expr (hpos d hd)

private theorem mem_eraseDups_iff {α : Type} [BEq α] [LawfulBEq α] {x : α} {xs : List α} :
    x ∈ xs.eraseDups ↔ x ∈ xs := by
  induction xs with
  | nil => simp [List.eraseDups]
  | cons hd tl _ =>
      have h := List.mem_eraseDups (a := x) (l := hd :: tl)
      exact h

private theorem subjectReachableStep_subset_self (active : List Tuple)
    (reached : List (EntityName × ObjId × RelName)) (x : EntityName × ObjId × RelName) :
    x ∈ reached → x ∈ subjectReachableStep active reached := by
  intro hx
  unfold subjectReachableStep
  rw [List.mem_eraseDups]
  exact List.mem_append_left _ hx

private theorem subjectReachableFuel_monotone_fuel (active : List Tuple) (a : Actor)
    {n₁ n₂ : Nat} (hle : n₁ ≤ n₂) :
    ∀ x, x ∈ subjectReachableFuel active a n₁ → x ∈ subjectReachableFuel active a n₂ := by
  induction hle with
  | refl => intro x hx; exact hx
  | @step k _ ih =>
      intro x hx
      exact subjectReachableStep_subset_self active (subjectReachableFuel active a k) x (ih x hx)

private theorem subjectReachableStep_monotone (active₁ active₂ : List Tuple)
    (hsub : ∀ t ∈ active₁, t ∈ active₂)
    (r₁ r₂ : List (EntityName × ObjId × RelName))
    (hr : ∀ x ∈ r₁, x ∈ r₂) :
    ∀ x ∈ subjectReachableStep active₁ r₁, x ∈ subjectReachableStep active₂ r₂ := by
  intro x hx
  unfold subjectReachableStep at hx ⊢
  rw [List.mem_eraseDups, List.mem_append] at hx ⊢
  rcases hx with hx | hx
  · exact Or.inl (hr x hx)
  · right
    rw [List.mem_filterMap] at hx ⊢
    rcases hx with ⟨t, ht₁, hmap⟩
    refine ⟨t, hsub t ht₁, ?_⟩
    cases hs : t.subject with
    | direct _ _ => rw [hs] at hmap; simp at hmap
    | wildcard _ => rw [hs] at hmap; simp at hmap
    | subjectSet sk sid sr =>
        rw [hs] at hmap
        dsimp only at hmap ⊢
        split at hmap
        · rename_i hcontains
          have hmem₁ : (sk, sid, sr) ∈ r₁ := List.contains_iff_mem.mp hcontains
          have hmem₂ : (sk, sid, sr) ∈ r₂ := hr _ hmem₁
          have hcontains₂ : r₂.contains (sk, sid, sr) = true := List.contains_iff_mem.mpr hmem₂
          simp only [hcontains₂, ↓reduceIte]
          exact hmap
        · simp at hmap

private theorem subjectReachableFuel_monotone_store (active₁ active₂ : List Tuple) (a : Actor)
    (hsub : ∀ t ∈ active₁, t ∈ active₂) :
    ∀ n x, x ∈ subjectReachableFuel active₁ a n → x ∈ subjectReachableFuel active₂ a n
  | 0, x, hx => by
      simp only [subjectReachableFuel, List.mem_eraseDups, List.mem_filterMap] at hx ⊢
      rcases hx with ⟨t, ht₁, hmap⟩
      exact ⟨t, hsub t ht₁, hmap⟩
  | n + 1, x, hx =>
      subjectReachableStep_monotone active₁ active₂ hsub
        (subjectReachableFuel active₁ a n)
        (subjectReachableFuel active₂ a n)
        (fun y hy => subjectReachableFuel_monotone_store active₁ active₂ a hsub n y hy)
        x hx

private theorem usersetMember_monotone_store (store₁ store₂ : List Tuple)
    (now : Timestamp) (a : Actor) (e : EntityName) (id : ObjId) (r : RelName)
    (hsub : ∀ t ∈ store₁, t ∈ store₂)
    (hlen : (activeTuples store₁ now).length ≤ (activeTuples store₂ now).length) :
    usersetMember store₁ now a e id r = true →
    usersetMember store₂ now a e id r = true := by
  intro h
  unfold usersetMember subjectReachable at h ⊢
  rw [List.contains_iff_mem] at h ⊢
  have hactiveSub : ∀ t ∈ activeTuples store₁ now, t ∈ activeTuples store₂ now := by
    intro t ht
    unfold activeTuples at ht ⊢
    rw [List.mem_filter] at ht ⊢
    exact ⟨hsub t ht.1, ht.2⟩
  have h1 := subjectReachableFuel_monotone_store
    (activeTuples store₁ now) (activeTuples store₂ now) a hactiveSub
    (activeTuples store₁ now).length (e, id, r) h
  exact subjectReachableFuel_monotone_fuel (activeTuples store₂ now) a hlen (e, id, r) h1

private theorem directEntityEdges_monotone_store (store₁ store₂ : List Tuple)
    (now : Timestamp) (e : EntityName) (id : ObjId) (rel : RelName)
    (hsub : ∀ t ∈ store₁, t ∈ store₂) :
    ∀ edge ∈ directEntityEdges store₁ now e id rel, edge ∈ directEntityEdges store₂ now e id rel := by
  intro edge hedge
  unfold directEntityEdges activeTuples at hedge ⊢
  rw [List.mem_filterMap] at hedge ⊢
  rcases hedge with ⟨t, ht₁, hmap⟩
  rw [List.mem_filter] at ht₁
  refine ⟨t, List.mem_filter.mpr ⟨hsub t ht₁.1, ht₁.2⟩, hmap⟩

private theorem evalExprWith_monotone_store (store₁ store₂ : List Tuple)
    (now : Timestamp) (a : Actor)
    (P Q : EntityName → ObjId → PermName → Bool)
    (hsub : ∀ t ∈ store₁, t ∈ store₂)
    (hlen : (activeTuples store₁ now).length ≤ (activeTuples store₂ now).length)
    (hPQ : PermLe P Q)
    (e : EntityName) (id : ObjId) :
    ∀ expr : Expr, expr.isPositive = true →
      evalExprWith store₁ now a P e id expr = true →
      evalExprWith store₂ now a Q e id expr = true
  | .rel r, _, h => by
      simp only [evalExprWith] at h ⊢
      exact usersetMember_monotone_store store₁ store₂ now a e id r hsub hlen h
  | .anyOf cs, hpos, h => by
      simp only [Expr.isPositive, List.all_eq_true] at hpos
      simp only [evalExprWith] at h ⊢
      exact list_any_monotone (fun c hc =>
        evalExprWith_monotone_store store₁ store₂ now a P Q hsub hlen hPQ e id c (hpos c hc)) h
  | .allOf cs, hpos, h => by
      simp only [Expr.isPositive, List.all_eq_true] at hpos
      simp only [evalExprWith] at h ⊢
      exact list_all_monotone (fun c hc =>
        evalExprWith_monotone_store store₁ store₂ now a P Q hsub hlen hPQ e id c (hpos c hc)) h
  | .exclude _ _, hpos, _ => by simp [Expr.isPositive] at hpos
  | .through rel targets, _, h => by
      simp only [evalExprWith, List.any_eq_true] at h ⊢
      rcases h with ⟨edge, hedge, htgt⟩
      refine ⟨edge, directEntityEdges_monotone_store store₁ store₂ now e id rel hsub edge hedge, ?_⟩
      rcases htgt with ⟨tgt, htgtMem, hmatch⟩
      simp only [Bool.and_eq_true] at hmatch
      exact ⟨tgt, htgtMem, by simp [hmatch.1, hPQ tgt.entity edge.2 tgt.perm hmatch.2]⟩
  | .throughAll _ _, hpos, _ => by simp [Expr.isPositive] at hpos
termination_by expr => sizeOf expr

/--
Revocation never escalates privileges: deleting any subset of tuples via
`store.filter keep` can only preserve or reduce access on positive policies.
-/
theorem revocation_no_escalation (m : AccessModel) (store : List Tuple)
    (keep : Tuple → Bool) (now : Timestamp) (a : Actor)
    (hpos : ModelPositive m) :
    ∀ k, PermLe (iterPermVal m (store.filter keep) now a k) (iterPermVal m store now a k)
  | 0 => by
      intro e id p h
      exact Bool.noConfusion h
  | k + 1 => by
      intro e id p h
      have hsub : ∀ t ∈ store.filter keep, t ∈ store := fun t ht => (List.mem_filter.mp ht).1
      have hlen : (activeTuples (store.filter keep) now).length ≤ (activeTuples store now).length := by
        unfold activeTuples
        rw [List.filter_filter]
        have hcomm : (fun t => tupleActive now t && keep t) = (fun t => keep t && tupleActive now t) := by
          funext t
          exact Bool.and_comm (tupleActive now t) (keep t)
        rw [hcomm, ← List.filter_filter]
        exact List.length_filter_le keep (store.filter (tupleActive now))
      unfold iterPermVal stepPermVal at h ⊢
      cases hfind : m.findPerm e p with
      | none => rw [hfind] at h; exact Bool.noConfusion h
      | some defn =>
          rw [hfind] at h
          dsimp only at h ⊢
          have hmem : defn ∈ m.permissions := List.mem_of_find?_eq_some hfind
          exact evalExprWith_monotone_store (store.filter keep) store now a
            (iterPermVal m (store.filter keep) now a k)
            (iterPermVal m store now a k)
            hsub hlen
            (revocation_no_escalation m store keep now a hpos k)
            e id defn.expr (hpos defn hmem) h

theorem revocation_check_no_escalation (m : AccessModel) (store : List Tuple)
    (keep : Tuple → Bool) (now : Timestamp) (a : Actor)
    (hpos : ModelPositive m) (e : EntityName) (id : ObjId) (p : PermName) :
    evalCheck m (store.filter keep) now a e id p = true →
    evalCheck m store now a e id p = true := by
  intro h
  unfold evalCheck evalPermFuel at h ⊢
  have h1 := revocation_no_escalation m store keep now a hpos (defaultFuel m (store.filter keep)) e id p h
  have hfuel : defaultFuel m (store.filter keep) ≤ defaultFuel m store := by
    unfold defaultFuel
    have hlen : (store.filter keep).length ≤ store.length := List.length_filter_le keep store
    exact Nat.mul_le_mul_right (m.permissions.length + 1) (Nat.add_le_add_right hlen 1)
  exact iterPermVal_monotone_fuel m store now a (model_positive_implies_monotonic m hpos) hfuel e id p h1

/-! ## 12. Multi-tenant namespace isolation -/

private theorem storeForNamespace_append_other (ns : String)
    (table other : List NamespacedTuple)
    (hdisjoint : ∀ row ∈ other, row.ns ≠ ns) :
    storeForNamespace ns (table ++ other) = storeForNamespace ns table := by
  unfold storeForNamespace
  rw [List.filter_append, List.map_append]
  have hnil : other.filter (fun row => row.ns == ns) = [] := by
    rw [List.filter_eq_nil_iff]
    intro row hrow
    simp only [beq_iff_eq]
    exact hdisjoint row hrow
  rw [hnil, List.map_nil, List.append_nil]

/--
Adding arbitrary tuples in any other namespace (`row.ns ≠ ns`) cannot affect
any permission check in namespace `ns`.
-/
theorem namespace_isolation_check (m : AccessModel) (ns : String)
    (table other : List NamespacedTuple)
    (hdisjoint : ∀ row ∈ other, row.ns ≠ ns)
    (now : Timestamp) (a : Actor) (e : EntityName) (id : ObjId) (p : PermName) :
    evalCheck m (storeForNamespace ns (table ++ other)) now a e id p =
    evalCheck m (storeForNamespace ns table) now a e id p := by
  rw [storeForNamespace_append_other ns table other hdisjoint]

/--
Adding arbitrary tuples in any other namespace (`row.ns ≠ ns`) cannot affect
any `lookupResources` / `compileFilter` result in namespace `ns`.
-/
theorem namespace_isolation_lookup (m : AccessModel) (ns : String)
    (table other : List NamespacedTuple)
    (hdisjoint : ∀ row ∈ other, row.ns ≠ ns)
    (now : Timestamp) (a : Actor) (e : EntityName) (p : PermName)
    (candidates : List ObjId) :
    lookupResourcesOver m (storeForNamespace ns (table ++ other)) now a e p candidates =
    lookupResourcesOver m (storeForNamespace ns table) now a e p candidates := by
  rw [storeForNamespace_append_other ns table other hdisjoint]

end DadsAccess
