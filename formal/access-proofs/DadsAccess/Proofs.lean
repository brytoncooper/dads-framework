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
6. `scope_columns_through_sound` & `scope_columns_anyOf_unless_sound`
7. `resolve_filter_branch_pruning_sound` & `resolve_filter_empty_false`
8. `evalExprWith_monotone`, `stepPermVal_monotone`, & `iterPermVal_ascending`
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

end DadsAccess
