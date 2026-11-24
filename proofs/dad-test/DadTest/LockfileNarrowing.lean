import DadTest.Types
import DadTest.Planner

namespace DadTest

/-- Normalized npm package name (e.g. `"zod"`, `"@dads-framework/testing"`). -/
abbrev PkgName := String

/--
Directed dependency edge in a lockfile graph: `dependent` depends on `dependency`.
A change to `dependency` propagates upward to `dependent`.
-/
structure LockDepEdge where
  dependent : PkgName
  dependency : PkgName
  deriving DecidableEq, Repr

/-- Parsed lockfile dependency graph together with the global toolchain package set. -/
structure LockfileGraph where
  packages : List PkgName
  edges : List LockDepEdge
  /-- Packages whose change affects all tasks globally (compilers, runners, linters, `@types/*`, etc.). -/
  toolchainPackages : List PkgName
  deriving DecidableEq, Repr

/--
Classification of a lockfile + manifest diff:
- `parseFailed`: unparseable lockfile, unsupported version, or non-dependency manifest change
  (e.g. `scripts`, `overrides`, `workspaces`, `engines`). Always widens to all tasks.
- `changed directChanged`: exact set of packages whose lockfile entry was added, removed, or
  modified between base and head.
-/
inductive LockfileDiff where
  | parseFailed
  | changed (directChanged : List PkgName)
  deriving DecidableEq, Repr

/-- External-package surface of a workspace task. -/
structure TaskExternalSpec where
  taskId : TaskId
  /-- Exact npm packages statically imported/required by modules reachable from this task. -/
  importedPackages : List PkgName
  /-- True if any reachable module has dynamic/unresolved `import()`/`require()` or unknown external edge. -/
  hasUnresolvedExternal : Bool
  deriving DecidableEq, Repr

/--
Single upward propagation step in the lockfile graph:
`LockUpStep edges low high` holds when `high` directly depends on `low`, so a change to `low`
can change `high`'s runtime or type behavior.
-/
def LockUpStep (edges : List LockDepEdge) (low high : PkgName) : Prop :=
  ∃ e ∈ edges, e.dependency = low ∧ e.dependent = high

/-- Reflexive-transitive upward propagation through lockfile dependency edges. -/
inductive LockReachable (edges : List LockDepEdge) : PkgName → PkgName → Prop where
  | refl (p : PkgName) : LockReachable edges p p
  | step {a b c : PkgName} :
      LockUpStep edges a b →
      LockReachable edges b c →
      LockReachable edges a c

theorem LockReachable.trans {edges : List LockDepEdge} {a b c : PkgName}
    (hab : LockReachable edges a b) (hbc : LockReachable edges b c) :
    LockReachable edges a c := by
  induction hab with
  | refl _ => exact hbc
  | step h _ ih => exact LockReachable.step h (ih hbc)

theorem LockReachable.snoc {edges : List LockDepEdge} {a b c : PkgName}
    (hab : LockReachable edges a b) (hbc : LockUpStep edges b c) :
    LockReachable edges a c :=
  hab.trans (LockReachable.step hbc (LockReachable.refl c))

/--
Ground-truth semantic relation: a task `t` may be affected by a lockfile diff `diff` iff at least
one of the following holds:
  1. `diff` failed to parse or touched global manifest fields (`parseFailed`),
  2. `diff = changed direct` is non-empty and `t` has an unresolved external import,
  3. some directly changed package `q` is unknown to `lock.packages` (fail closed),
  4. some directly changed package `q` transitively reaches a global toolchain package, or
  5. some directly changed package `q` transitively reaches a package in `t.importedPackages`.
-/
def TaskMayBeAffectedByLockfile
    (lock : LockfileGraph) (diff : LockfileDiff) (t : TaskExternalSpec) : Prop :=
  match diff with
  | .parseFailed => True
  | .changed direct =>
      direct ≠ [] ∧
      (t.hasUnresolvedExternal = true ∨
       (∃ q ∈ direct, q ∉ lock.packages) ∨
       (∃ q ∈ direct, ∃ tc ∈ lock.toolchainPackages,
         q ∈ lock.packages ∧ tc ∈ lock.packages ∧ LockReachable lock.edges q tc) ∨
       (∃ q ∈ direct, ∃ p ∈ t.importedPackages,
         q ∈ lock.packages ∧ p ∈ lock.packages ∧ LockReachable lock.edges q p))

/-- One upward expansion step in the lockfile dependency graph. -/
def expandLockOnce (lock : LockfileGraph) (reached : List PkgName) : List PkgName :=
  let next := lock.packages.filter (fun p =>
    lock.edges.any (fun e => e.dependent == p && reached.contains e.dependency))
  next.foldl (fun acc p => if acc.contains p then acc else p :: acc) reached

/-- Bounded fixed-point iteration over `lock.packages.length` steps. -/
def expandLockN (lock : LockfileGraph) : Nat → List PkgName → List PkgName
  | 0, reached => reached
  | n + 1, reached => expandLockN lock n (expandLockOnce lock reached)

/-- Full upward closure of directly changed packages inside `lock.packages`. -/
def lockImpactClosure (lock : LockfileGraph) (direct : List PkgName) : List PkgName :=
  expandLockN lock lock.packages.length (direct.filter (fun p => lock.packages.contains p))

/-- Whether a lockfile diff must fail closed and widen to every task. -/
def lockfileMustWiden (lock : LockfileGraph) (diff : LockfileDiff) : Bool :=
  match diff with
  | .parseFailed => true
  | .changed direct =>
      if direct.isEmpty then false
      else
        direct.any (fun q => !lock.packages.contains q) ||
        (lockImpactClosure lock direct).any (fun p => lock.toolchainPackages.contains p)

/-- Executable fail-closed task selector for lockfile diffs. -/
def selectTasksForLockfileDiff
    (lock : LockfileGraph) (diff : LockfileDiff) (tasks : List TaskExternalSpec) : List TaskId :=
  match diff with
  | .parseFailed => tasks.map (·.taskId)
  | .changed direct =>
      if direct.isEmpty then []
      else if lockfileMustWiden lock (.changed direct) then
        tasks.map (·.taskId)
      else
        let impacted := lockImpactClosure lock direct
        (tasks.filter (fun t =>
          t.hasUnresolvedExternal ||
          t.importedPackages.any (fun p => impacted.contains p))).map (·.taskId)

/-! ### Helper lemmas for upward closure completeness -/

private theorem mem_foldl_dedup (xs acc : List PkgName) (x : PkgName) :
    x ∈ xs.foldl (fun a o => if a.contains o then a else o :: a) acc ↔ x ∈ acc ∨ x ∈ xs := by
  induction xs generalizing acc with
  | nil => simp
  | cons y ys ih =>
      simp only [List.foldl_cons, ih, List.mem_cons]
      by_cases hy : y ∈ acc
      · have hcontains : acc.contains y = true := List.contains_iff_mem.mpr hy
        simp only [hcontains, ↓reduceIte]
        constructor
        · rintro (h | h)
          · exact Or.inl h
          · exact Or.inr (Or.inr h)
        · rintro (h | rfl | h)
          · exact Or.inl h
          · exact Or.inl hy
          · exact Or.inr h
      · have hcontains : acc.contains y = false := by
          cases hc : acc.contains y
          · rfl
          · exact absurd (List.contains_iff_mem.mp hc) hy
        simp only [hcontains, Bool.false_eq_true, ↓reduceIte, List.mem_cons]
        constructor
        · rintro ((rfl | h) | h)
          · exact Or.inr (Or.inl rfl)
          · exact Or.inl h
          · exact Or.inr (Or.inr h)
        · rintro (h | rfl | h)
          · exact Or.inl (Or.inr h)
          · exact Or.inl (Or.inl rfl)
          · exact Or.inr h

private theorem mem_expandLockOnce (lock : LockfileGraph) (S : List PkgName) (x : PkgName) :
    x ∈ expandLockOnce lock S ↔
      x ∈ S ∨ (x ∈ lock.packages ∧ ∃ y ∈ S, LockUpStep lock.edges y x) := by
  unfold expandLockOnce
  rw [mem_foldl_dedup, List.mem_filter]
  constructor
  · rintro (hxS | ⟨hxPkg, hany⟩)
    · exact Or.inl hxS
    · rcases List.any_eq_true.mp hany with ⟨e, he, hcond⟩
      simp only [Bool.and_eq_true, beq_iff_eq] at hcond
      exact Or.inr ⟨hxPkg, e.dependency, List.contains_iff_mem.mp hcond.2, ⟨e, he, rfl, hcond.1⟩⟩
  · rintro (hxS | ⟨hxPkg, y, hyS, ⟨e, he, hdep, hpar⟩⟩)
    · exact Or.inl hxS
    · right
      refine ⟨hxPkg, ?_⟩
      rw [List.any_eq_true]
      refine ⟨e, he, ?_⟩
      simp [hpar, hdep, hyS]

private theorem mem_expandLockN_mono (lock : LockfileGraph) (k : Nat) (S : List PkgName) (x : PkgName)
    (hx : x ∈ S) : x ∈ expandLockN lock k S := by
  induction k generalizing S with
  | zero => exact hx
  | succ k ih =>
      exact ih (expandLockOnce lock S) ((mem_expandLockOnce lock S x).mpr (Or.inl hx))

private theorem expandLockN_fixed_if_once_fixed (lock : LockfileGraph) (k : Nat) (S : List PkgName)
    (hfixed : ∀ x, x ∈ expandLockOnce lock S → x ∈ S) :
    ∀ x, x ∈ expandLockN lock k S → x ∈ S := by
  induction k generalizing S with
  | zero => intro _ hx; exact hx
  | succ k ih =>
      intro x hx
      have hstep : ∀ z, z ∈ expandLockOnce lock (expandLockOnce lock S) → z ∈ expandLockOnce lock S := by
        intro z hz
        rcases (mem_expandLockOnce lock (expandLockOnce lock S) z).mp hz with hz1 | ⟨hpkg, y, hy1, hst⟩
        · exact hz1
        · exact (mem_expandLockOnce lock S z).mpr (Or.inr ⟨hpkg, y, hfixed y hy1, hst⟩)
      exact hfixed x (ih (expandLockOnce lock S) hstep x hx)

private def missingPkgCount (pkgs S : List PkgName) : Nat :=
  (pkgs.filter (fun p => !S.contains p)).length

private theorem lock_filter_len_lt {α : Type} [BEq α] [LawfulBEq α]
    (l : List α) (p q : α → Bool)
    (himp : ∀ a ∈ l, q a = true → p a = true)
    (hw : ∃ w ∈ l, p w = true ∧ q w = false) :
    (l.filter q).length < (l.filter p).length := by
  induction l with
  | nil =>
      rcases hw with ⟨_, hmem, _⟩
      simp at hmem
  | cons a as ih =>
      have himp' : ∀ x ∈ as, q x = true → p x = true :=
        fun x hx => himp x (List.mem_cons_of_mem a hx)
      rcases hw with ⟨w, hwmem, hpw, hqw⟩
      rw [List.mem_cons] at hwmem
      rcases hwmem with rfl | hwas
      · simp only [List.filter_cons, hpw, hqw, Bool.false_eq_true, ↓reduceIte, List.length_cons]
        have hle : (as.filter q).length ≤ (as.filter p).length := by
          clear hpw hqw himp ih
          induction as with
          | nil => simp
          | cons b bs ihb =>
              simp only [List.filter_cons]
              have hb := himp' b (List.mem_cons_self ..)
              have ihb' := ihb (fun x hx => himp' x (List.mem_cons_of_mem b hx))
              cases hqb : q b <;> cases hpb : p b
              · exact ihb'
              · exact Nat.le_succ_of_le ihb'
              · exact absurd (hb hqb) (by simp [hpb])
              · exact Nat.succ_le_succ ihb'
        exact Nat.lt_succ_of_le hle
      · simp only [List.filter_cons]
        have ha := himp a (List.mem_cons_self ..)
        have hlt := ih himp' ⟨w, hwas, hpw, hqw⟩
        cases hqa : q a <;> cases hpa : p a
        · exact hlt
        · exact Nat.lt_succ_of_lt hlt
        · exact absurd (ha hqa) (by simp [hpa])
        · exact Nat.succ_lt_succ hlt

private theorem expandLockN_reaches_fixpoint (lock : LockfileGraph) (k : Nat) (S : List PkgName)
    (hbound : missingPkgCount lock.packages S ≤ k) :
    ∀ x, x ∈ expandLockOnce lock (expandLockN lock k S) → x ∈ expandLockN lock k S := by
  induction k generalizing S with
  | zero =>
      have hzero : missingPkgCount lock.packages S = 0 := Nat.eq_zero_of_le_zero hbound
      intro x hx
      rcases (mem_expandLockOnce lock S x).mp hx with hS | ⟨hxPkg, _⟩
      · exact hS
      · by_cases hmem : S.contains x
        · exact List.contains_iff_mem.mp hmem
        · exfalso
          have hpos : 0 < missingPkgCount lock.packages S := by
            unfold missingPkgCount
            apply List.length_pos_of_mem (a := x)
            rw [List.mem_filter]
            exact ⟨hxPkg, by simp; exact fun hm => hmem (List.contains_iff_mem.mpr hm)⟩
          omega
  | succ k ih =>
      by_cases hfixed : (expandLockOnce lock S).all (fun z => S.contains z) = true
      · have hfix : ∀ x, x ∈ expandLockOnce lock S → x ∈ S := fun x hx =>
          List.contains_iff_mem.mp (List.all_eq_true.mp hfixed x hx)
        intro x hx
        have hstep : ∀ z, z ∈ expandLockN lock (k + 1) S → z ∈ S :=
          expandLockN_fixed_if_once_fixed lock (k + 1) S hfix
        have hS : x ∈ S := by
          rcases (mem_expandLockOnce lock (expandLockN lock (k + 1) S) x).mp hx with h1 | ⟨hpkg, y, hy1, hst⟩
          · exact hstep x h1
          · exact hfix x ((mem_expandLockOnce lock S x).mpr (Or.inr ⟨hpkg, y, hstep y hy1, hst⟩))
        exact mem_expandLockN_mono lock (k + 1) S x hS
      · have hfalse : (expandLockOnce lock S).all (fun z => S.contains z) = false :=
          Bool.eq_false_iff.mpr hfixed
        rcases List.all_eq_false.mp hfalse with ⟨w, hw1, hwNot⟩
        have hwS : w ∉ S := fun hm => hwNot (List.contains_iff_mem.mpr hm)
        have hwPkg : w ∈ lock.packages := by
          rcases (mem_expandLockOnce lock S w).mp hw1 with h | ⟨hpkg, _⟩
          · exact absurd h hwS
          · exact hpkg
        have hlt : missingPkgCount lock.packages (expandLockOnce lock S) < missingPkgCount lock.packages S := by
          unfold missingPkgCount
          apply lock_filter_len_lt
          · intro a _ hq
            simp only [Bool.not_eq_true'] at hq ⊢
            cases hpa : S.contains a
            · rfl
            · have hmem : a ∈ S := List.contains_iff_mem.mp hpa
              have hmem1 : a ∈ expandLockOnce lock S := (mem_expandLockOnce lock S a).mpr (Or.inl hmem)
              have hc : (expandLockOnce lock S).contains a = true := List.contains_iff_mem.mpr hmem1
              rw [hc] at hq
              simp at hq
          · refine ⟨w, hwPkg, ?_, ?_⟩
            · simp [hwS]
            · simp [hw1]
        exact ih (expandLockOnce lock S) (by omega)

private theorem lockImpactClosure_closed (lock : LockfileGraph) (direct : List PkgName) :
    ∀ x ∈ lock.packages, ∀ y ∈ lockImpactClosure lock direct,
      LockUpStep lock.edges y x → x ∈ lockImpactClosure lock direct := by
  intro x hx y hy hst
  unfold lockImpactClosure at hy ⊢
  apply expandLockN_reaches_fixpoint lock lock.packages.length
    (direct.filter (fun p => lock.packages.contains p))
    (List.length_filter_le _ _)
  exact (mem_expandLockOnce lock _ x).mpr (Or.inr ⟨hx, y, hy, hst⟩)

private theorem lockImpactClosure_forward_closed
    (lock : LockfileGraph) (direct : List PkgName)
    (hEdgesClosed : ∀ e ∈ lock.edges, e.dependent ∈ lock.packages)
    {src dst : PkgName} (hsrc : src ∈ lockImpactClosure lock direct)
    (hreach : LockReachable lock.edges src dst) :
    dst ∈ lockImpactClosure lock direct := by
  induction hreach with
  | refl _ => exact hsrc
  | @step a b _ hst _ ih =>
      have hbPkg : b ∈ lock.packages := by
        rcases hst with ⟨e, he, _, rfl⟩
        exact hEdgesClosed e he
      exact ih (lockImpactClosure_closed lock direct b hbPkg a hsrc hst)

theorem lockImpactClosure_complete
    (lock : LockfileGraph) (direct : List PkgName)
    (hEdgesClosed : ∀ e ∈ lock.edges, e.dependent ∈ lock.packages)
    {q dst : PkgName} (hq : q ∈ direct) (hqPkg : q ∈ lock.packages)
    (hreach : LockReachable lock.edges q dst) :
    dst ∈ lockImpactClosure lock direct := by
  have hseed : q ∈ lockImpactClosure lock direct := by
    unfold lockImpactClosure
    apply mem_expandLockN_mono
    rw [List.mem_filter]
    exact ⟨hq, List.contains_iff_mem.mpr hqPkg⟩
  exact lockImpactClosure_forward_closed lock direct hEdgesClosed hseed hreach

/-! ### Main Theorems -/

/--
**Theorem 1 (Lockfile Narrowing Soundness):**
If every lockfile edge's dependent is listed in `lock.packages`, then any task `t ∈ tasks`
that may be affected by `diff` (directly, via any transitive npm dependency, via a global
toolchain package, via an unknown package, via an unresolved external import, or via a
lockfile parse failure) is guaranteed to be selected by `selectTasksForLockfileDiff`.
-/
theorem lockfile_narrowing_sound
    (lock : LockfileGraph) (diff : LockfileDiff) (tasks : List TaskExternalSpec)
    (hEdgesClosed : ∀ e ∈ lock.edges, e.dependent ∈ lock.packages)
    {t : TaskExternalSpec} (ht : t ∈ tasks)
    (hAff : TaskMayBeAffectedByLockfile lock diff t) :
    t.taskId ∈ selectTasksForLockfileDiff lock diff tasks := by
  cases diff with
  | parseFailed =>
      simp only [selectTasksForLockfileDiff]
      exact List.mem_map_of_mem ht
  | changed direct =>
      rcases hAff with ⟨hNonEmpty, hCase⟩
      have hEmptyFalse : direct.isEmpty = false := by
        cases direct with
        | nil => exact absurd rfl hNonEmpty
        | cons _ _ => rfl
      simp only [selectTasksForLockfileDiff, hEmptyFalse, Bool.false_eq_true, ↓reduceIte]
      by_cases hw : lockfileMustWiden lock (.changed direct) = true
      · simp only [hw, ↓reduceIte]
        exact List.mem_map_of_mem ht
      · simp only [hw, Bool.false_eq_true, ↓reduceIte]
        rcases hCase with hUnres | ⟨q, hq, hqNotPkg⟩ | ⟨q, hq, tc, htc, hqPkg, _, hreach⟩ | ⟨q, hq, p, hp, hqPkg, _, hreach⟩
        · apply List.mem_map_of_mem
          rw [List.mem_filter]
          exact ⟨ht, by simp [hUnres]⟩
        · exfalso
          apply hw
          simp only [lockfileMustWiden, hEmptyFalse, Bool.false_eq_true, ↓reduceIte, Bool.or_eq_true]
          left
          rw [List.any_eq_true]
          refine ⟨q, hq, ?_⟩
          simp [hqNotPkg]
        · exfalso
          apply hw
          simp only [lockfileMustWiden, hEmptyFalse, Bool.false_eq_true, ↓reduceIte, Bool.or_eq_true]
          right
          rw [List.any_eq_true]
          refine ⟨tc, lockImpactClosure_complete lock direct hEdgesClosed hq hqPkg hreach, ?_⟩
          exact List.contains_iff_mem.mpr htc
        · apply List.mem_map_of_mem
          rw [List.mem_filter]
          refine ⟨ht, ?_⟩
          simp only [Bool.or_eq_true]
          right
          rw [List.any_eq_true]
          refine ⟨p, hp, ?_⟩
          exact List.contains_iff_mem.mpr (lockImpactClosure_complete lock direct hEdgesClosed hq hqPkg hreach)

private theorem expandLockOnce_isolated (lock : LockfileGraph) (pNew : PkgName)
    (hNoDeps : ∀ e ∈ lock.edges, e.dependency ≠ pNew)
    (S : List PkgName) (hS : ∀ x ∈ S, x = pNew) :
    ∀ x ∈ expandLockOnce lock S, x = pNew := by
  intro x hx
  rcases (mem_expandLockOnce lock S x).mp hx with hxS | ⟨_, y, hyS, ⟨e, he, hdep, _⟩⟩
  · exact hS x hxS
  · have hyEq : y = pNew := hS y hyS
    rw [hyEq] at hdep
    exact absurd hdep (hNoDeps e he)

private theorem expandLockN_isolated (lock : LockfileGraph) (pNew : PkgName)
    (hNoDeps : ∀ e ∈ lock.edges, e.dependency ≠ pNew) :
    ∀ n S, (∀ x ∈ S, x = pNew) → ∀ x ∈ expandLockN lock n S, x = pNew := by
  intro n
  induction n with
  | zero =>
      intro S hS x hx
      exact hS x hx
  | succ k ih =>
      intro S hS x hx
      exact ih (expandLockOnce lock S) (expandLockOnce_isolated lock pNew hNoDeps S hS) x hx

/--
**Theorem 2 (Precision — Unused New Dependency Skips Unrelated Tasks):**
Adding a single brand-new package `pNew` that no existing package depends on and that is not in
`toolchainPackages` does NOT select any task `t` that neither imports `pNew` nor has unresolved
external imports (assuming task IDs are unique across `tasks`).
-/
theorem unused_new_package_skips_unrelated_task
    (lock : LockfileGraph) (pNew : PkgName) (tasks : List TaskExternalSpec)
    (hpPkg : pNew ∈ lock.packages)
    (hNoDeps : ∀ e ∈ lock.edges, e.dependency ≠ pNew)
    (hNotTool : pNew ∉ lock.toolchainPackages)
    {t : TaskExternalSpec}
    (hUniqueId : ∀ t' ∈ tasks, t'.taskId = t.taskId → t' = t)
    (hNoUnres : t.hasUnresolvedExternal = false)
    (hNotImp : pNew ∉ t.importedPackages) :
    t.taskId ∉ selectTasksForLockfileDiff lock (.changed [pNew]) tasks := by
  have hClosureEq : ∀ x ∈ lockImpactClosure lock [pNew], x = pNew := by
    intro x hx
    unfold lockImpactClosure at hx
    exact expandLockN_isolated lock pNew hNoDeps lock.packages.length _
      (fun y hy => by
        rw [List.mem_filter] at hy
        simpa using hy.1)
      x hx
  have hWidenFalse : lockfileMustWiden lock (.changed [pNew]) = false := by
    simp only [lockfileMustWiden, List.isEmpty_cons, Bool.false_eq_true, ↓reduceIte,
      Bool.or_eq_false_iff, List.any_eq_false]
    constructor
    · intro q hq
      have hqEq : q = pNew := by simpa using hq
      subst hqEq
      simp [hpPkg]
    · intro p hp
      have hpEq : p = pNew := hClosureEq p hp
      subst hpEq
      simp [hNotTool]
  simp only [selectTasksForLockfileDiff, List.isEmpty_cons, Bool.false_eq_true, ↓reduceIte,
    hWidenFalse]
  intro hMem
  rcases List.mem_map.mp hMem with ⟨t', ht'Filt, ht'Id⟩
  rcases List.mem_filter.mp ht'Filt with ⟨ht'In, ht'Pred⟩
  have htEq : t' = t := hUniqueId t' ht'In ht'Id
  subst htEq
  simp only [hNoUnres, Bool.false_or, List.any_eq_true] at ht'Pred
  rcases ht'Pred with ⟨p, hpImp, hpClos⟩
  have hpEq : p = pNew := hClosureEq p (List.contains_iff_mem.mp hpClos)
  subst hpEq
  exact hNotImp hpImp

end DadTest
