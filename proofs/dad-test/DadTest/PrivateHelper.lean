import DadTest.Types

namespace DadTest

/-- Identifier for a top-level declaration inside a module (exported or private). -/
abbrev DeclId := String

/-- Attribution of a single changed diff hunk inside a module. -/
inductive HunkAttribution where
  /-- Hunk lies strictly inside a single pure top-level declaration `d`. -/
  | inDecl (d : DeclId)
  /-- Hunk falls outside any known pure top-level declaration (e.g. top-level statement, span overlap). -/
  | unattributed
  deriving DecidableEq, Repr

/-- Intra-file def-use representation of a single JS/TS module. -/
structure ModuleIR where
  /-- True iff every top-level statement is side-effect-free (no top-level execution at import time). -/
  isPureTopLevel : Bool
  /-- All top-level declarations (both exported and non-exported private helpers). -/
  decls : List DeclId
  /-- Exported public name(s) bound to a declaration (`none` for private helpers). -/
  exportedName : DeclId → Option Symbol
  /-- Intra-file def-use: `uses caller` lists declarations referenced in `caller`'s body. -/
  uses : DeclId → List DeclId
  /-- Diff hunks observed in this module. -/
  hunks : List HunkAttribution

/--
Reflexive-transitive intra-file dependency relation: `UsesStar uses caller target` holds
when `caller` directly or transitively references `target` inside the same module
(covering arbitrarily deep private helper chains and mutual recursion cycles).
-/
inductive UsesStar (uses : DeclId → List DeclId) : DeclId → DeclId → Prop where
  | refl (d : DeclId) : UsesStar uses d d
  | step {a b c : DeclId} :
      b ∈ uses a →
      UsesStar uses b c →
      UsesStar uses a c

theorem UsesStar.trans {uses : DeclId → List DeclId} {a b c : DeclId}
    (hab : UsesStar uses a b) (hbc : UsesStar uses b c) : UsesStar uses a c := by
  induction hab with
  | refl _ => exact hbc
  | step h _ ih => exact UsesStar.step h (ih hbc)

theorem UsesStar.snoc {uses : DeclId → List DeclId} {a b c : DeclId}
    (hab : UsesStar uses a b) (hbc : c ∈ uses b) : UsesStar uses a c :=
  hab.trans (UsesStar.step hbc (UsesStar.refl c))

/--
Ground-truth semantic relation for pure, fully attributed modules:
an exported symbol `sym` may observe a diff hunk if some declared export `e`
bound to `sym` transitively uses a declaration `d` that contains a changed hunk.
-/
def ExportMayObserveHunk (m : ModuleIR) (sym : Symbol) : Prop :=
  ∃ e ∈ m.decls, m.exportedName e = some sym ∧
    ∃ d ∈ m.decls, HunkAttribution.inDecl d ∈ m.hunks ∧ UsesStar m.uses e d

/-- One reverse-def-use expansion step: add any `caller ∈ decls` that uses a reached declaration. -/
def expandReverseOnce (m : ModuleIR) (reached : List DeclId) : List DeclId :=
  let callers := m.decls.filter (fun caller => (m.uses caller).any (fun callee => reached.contains callee))
  callers.foldl (fun acc d => if acc.contains d then acc else d :: acc) reached

/-- Bounded fixed-point iteration over `m.decls.length` steps. -/
def expandReverseN (m : ModuleIR) : Nat → List DeclId → List DeclId
  | 0, reached => reached
  | n + 1, reached => expandReverseN m n (expandReverseOnce m reached)

/-- Seed declarations directly containing an attributed hunk (that exist in `m.decls`). -/
def seedChangedDecls (m : ModuleIR) : List DeclId :=
  m.hunks.filterMap (fun h =>
    match h with
    | HunkAttribution.inDecl d => if m.decls.contains d then some d else none
    | HunkAttribution.unattributed => none)

/-- All declarations in `m.decls` that transitively depend on any changed declaration. -/
def reverseDefUseClosure (m : ModuleIR) : List DeclId :=
  expandReverseN m m.decls.length (seedChangedDecls m)

/-- True iff every hunk in `m.hunks` lies inside a known declaration in `m.decls`. -/
def allHunksInKnownDecls (m : ModuleIR) : Bool :=
  m.hunks.all (fun h =>
    match h with
    | HunkAttribution.inDecl d => m.decls.contains d
    | HunkAttribution.unattributed => false)

/--
Executable private-helper hunk attribution algorithm matching the Rust implementation:
- Empty hunks -> no semantic change.
- Impure top-level module OR any unattributed hunk -> `complete = false` (widens conservatively).
- Pure top-level module with all hunks in known declarations -> exact reverse def-use closure
  projected to exported names.
-/
def attributeModuleHunks (m : ModuleIR) : ChangeEvidence :=
  if m.hunks.isEmpty then
    { complete := true, semanticChange := false, exports := [] }
  else if !m.isPureTopLevel || !allHunksInKnownDecls m then
    { complete := false, semanticChange := true, exports := [] }
  else
    let reached := reverseDefUseClosure m
    let exports := m.decls.filterMap (fun d =>
      if reached.contains d then m.exportedName d else none)
    { complete := true, semanticChange := true, exports := exports }

/-! ### Helper lemmas on `foldl` deduplicating insertion -/

private theorem mem_foldl_dedup {α : Type} [BEq α] [LawfulBEq α]
    (xs acc : List α) (x : α) :
    x ∈ xs.foldl (fun a y => if a.contains y then a else y :: a) acc ↔ x ∈ acc ∨ x ∈ xs := by
  induction xs generalizing acc with
  | nil => simp
  | cons y ys ih =>
    simp only [List.foldl_cons, ih]
    by_cases h : acc.contains y
    · simp only [h, ↓reduceIte, List.mem_cons]
      have hy : y ∈ acc := List.contains_iff_mem.mp h
      constructor
      · intro h'
        rcases h' with hacc | hys
        · exact Or.inl hacc
        · exact Or.inr (Or.inr hys)
      · intro h'
        rcases h' with hacc | (rfl | hys)
        · exact Or.inl hacc
        · exact Or.inl hy
        · exact Or.inr hys
    · simp only [h, Bool.false_eq_true, ↓reduceIte, List.mem_cons]
      constructor
      · rintro ((rfl | hacc) | hys)
        · exact Or.inr (Or.inl rfl)
        · exact Or.inl hacc
        · exact Or.inr (Or.inr hys)
      · rintro (hacc | (rfl | hys))
        · exact Or.inl (Or.inr hacc)
        · exact Or.inl (Or.inl rfl)
        · exact Or.inr hys

private theorem mem_expandReverseOnce (m : ModuleIR) (reached : List DeclId) (x : DeclId) :
    x ∈ expandReverseOnce m reached ↔
      x ∈ reached ∨ (x ∈ m.decls ∧ ∃ y ∈ m.uses x, y ∈ reached) := by
  unfold expandReverseOnce
  rw [mem_foldl_dedup]
  simp only [List.mem_filter, List.any_eq_true, List.contains_iff_mem]

private theorem mem_expandReverseN_mono (m : ModuleIR) (k : Nat) (reached : List DeclId) (x : DeclId)
    (hx : x ∈ reached) : x ∈ expandReverseN m k reached := by
  induction k generalizing reached with
  | zero => exact hx
  | succ k ih =>
    apply ih
    exact (mem_expandReverseOnce m reached x).mpr (Or.inl hx)

private theorem expandReverseOnce_subset_decls (m : ModuleIR) (reached : List DeclId)
    (hsub : ∀ x ∈ reached, x ∈ m.decls) :
    ∀ x ∈ expandReverseOnce m reached, x ∈ m.decls := by
  intro x hx
  rcases (mem_expandReverseOnce m reached x).mp hx with h | ⟨hdecl, _⟩
  · exact hsub x h
  · exact hdecl

private theorem expandReverseN_subset_decls (m : ModuleIR) (k : Nat) (reached : List DeclId)
    (hsub : ∀ x ∈ reached, x ∈ m.decls) :
    ∀ x ∈ expandReverseN m k reached, x ∈ m.decls := by
  induction k generalizing reached with
  | zero => exact hsub
  | succ k ih =>
    exact ih (expandReverseOnce m reached) (expandReverseOnce_subset_decls m reached hsub)

private theorem seedChangedDecls_subset_decls (m : ModuleIR) :
    ∀ x ∈ seedChangedDecls m, x ∈ m.decls := by
  intro x hx
  unfold seedChangedDecls at hx
  rw [List.mem_filterMap] at hx
  rcases hx with ⟨h, _, hmatch⟩
  cases h with
  | unattributed => simp at hmatch
  | inDecl d =>
    simp only at hmatch
    split at hmatch
    · injection hmatch with hEq
      subst hEq
      exact List.contains_iff_mem.mp ‹_›
    · simp at hmatch

/-! ### Pigeonhole fixed-point lemma: `m.decls.length` steps suffice for full closure -/

private theorem expandReverseOnce_fixed_implies_closed (m : ModuleIR) (S : List DeclId)
    (hfixed : ∀ x, x ∈ expandReverseOnce m S → x ∈ S) :
    ∀ x ∈ m.decls, ∀ y ∈ m.uses x, y ∈ S → x ∈ S := by
  intro x hx y hy hyS
  apply hfixed
  exact (mem_expandReverseOnce m S x).mpr (Or.inr ⟨hx, y, hy, hyS⟩)

private theorem expandReverseN_fixed_if_once_fixed (m : ModuleIR) (k : Nat) (S : List DeclId)
    (hfixed : ∀ x, x ∈ expandReverseOnce m S → x ∈ S) :
    ∀ x, x ∈ expandReverseN m k S → x ∈ S := by
  induction k generalizing S with
  | zero => intro x hx; exact hx
  | succ k ih =>
    intro x hx
    have hstep : ∀ z, z ∈ expandReverseOnce m (expandReverseOnce m S) → z ∈ expandReverseOnce m S := by
      intro z hz
      rcases (mem_expandReverseOnce m (expandReverseOnce m S) z).mp hz with hz1 | ⟨hdecl, y, hy, hy1⟩
      · exact hz1
      · exact (mem_expandReverseOnce m S z).mpr (Or.inr ⟨hdecl, y, hy, hfixed y hy1⟩)
    exact hfixed x (ih (expandReverseOnce m S) hstep x hx)

/-- Count of elements of `m.decls` not yet in `S`. -/
private def missingCount (decls S : List DeclId) : Nat :=
  (decls.filter (fun d => !S.contains d)).length

private theorem filter_length_lt_of_subset_and_witness {α : Type} [BEq α] [LawfulBEq α]
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

private theorem expandReverseN_reaches_fixpoint (m : ModuleIR) (k : Nat) (S : List DeclId)
    (hbound : missingCount m.decls S ≤ k) :
    ∀ x, x ∈ expandReverseOnce m (expandReverseN m k S) → x ∈ expandReverseN m k S := by
  induction k generalizing S with
  | zero =>
    have hzero : missingCount m.decls S = 0 := Nat.eq_zero_of_le_zero hbound
    intro x hx
    rcases (mem_expandReverseOnce m S x).mp hx with hS | ⟨hxdecl, _⟩
    · exact hS
    · by_cases hmem : S.contains x
      · exact List.contains_iff_mem.mp hmem
      · exfalso
        have hpos : 0 < missingCount m.decls S := by
          unfold missingCount
          apply List.length_pos_of_mem (a := x)
          rw [List.mem_filter]
          exact ⟨hxdecl, by simp; exact fun hm => hmem (List.contains_iff_mem.mpr hm)⟩
        omega
  | succ k ih =>
    by_cases hfixed : (expandReverseOnce m S).all (fun z => S.contains z) = true
    · have hfix : ∀ x, x ∈ expandReverseOnce m S → x ∈ S := by
        intro x hx
        exact List.contains_iff_mem.mp (List.all_eq_true.mp hfixed x hx)
      intro x hx
      have hstep : ∀ z, z ∈ expandReverseN m (k + 1) S → z ∈ S :=
        expandReverseN_fixed_if_once_fixed m (k + 1) S hfix
      have hS : x ∈ S := by
        rcases (mem_expandReverseOnce m (expandReverseN m (k + 1) S) x).mp hx with h1 | ⟨hdecl, y, hy, hy1⟩
        · exact hstep x h1
        · exact hfix x ((mem_expandReverseOnce m S x).mpr (Or.inr ⟨hdecl, y, hy, hstep y hy1⟩))
      exact mem_expandReverseN_mono m (k + 1) S x hS
    · have hfalse : (expandReverseOnce m S).all (fun z => S.contains z) = false :=
        Bool.eq_false_iff.mpr hfixed
      rcases List.all_eq_false.mp hfalse with ⟨w, hw1, hwNot⟩
      have hwS : w ∉ S := fun hm => hwNot (List.contains_iff_mem.mpr hm)
      have hwdecl : w ∈ m.decls := by
        rcases (mem_expandReverseOnce m S w).mp hw1 with h | ⟨hdecl, _⟩
        · exact absurd h hwS
        · exact hdecl
      have hlt : missingCount m.decls (expandReverseOnce m S) < missingCount m.decls S := by
        unfold missingCount
        apply filter_length_lt_of_subset_and_witness
        · intro a _ hq
          simp only [Bool.not_eq_true'] at hq ⊢
          cases hpa : S.contains a
          · rfl
          · have hmem : a ∈ S := List.contains_iff_mem.mp hpa
            have hmem1 : a ∈ expandReverseOnce m S :=
              (mem_expandReverseOnce m S a).mpr (Or.inl hmem)
            have hc : (expandReverseOnce m S).contains a = true := List.contains_iff_mem.mpr hmem1
            rw [hc] at hq
            simp at hq
        · refine ⟨w, hwdecl, ?_, ?_⟩
          · simp [hwS]
          · simp [hw1]
      exact ih (expandReverseOnce m S) (by omega)

private theorem reverseDefUseClosure_closed (m : ModuleIR) :
    ∀ x ∈ m.decls, ∀ y ∈ m.uses x, y ∈ reverseDefUseClosure m → x ∈ reverseDefUseClosure m := by
  unfold reverseDefUseClosure
  apply expandReverseOnce_fixed_implies_closed
  apply expandReverseN_reaches_fixpoint
  unfold missingCount
  exact List.length_filter_le _ _

/-- Every declaration `e ∈ m.decls` that transitively uses a closed member `d` is also in the closure,
    assuming intermediate nodes on the chain are top-level declarations in `m.decls`. -/
def UsesStarInDecls (m : ModuleIR) : DeclId → DeclId → Prop :=
  fun a b => UsesStar (fun d => (m.uses d).filter (fun u => m.decls.contains u)) a b

/--
When `m.uses` only points to declarations in `m.decls` (well-formed intra-file graph),
`reverseDefUseClosure m` is closed backwards under arbitrary transitive `UsesStar`.
-/
theorem reverseDefUseClosure_backwards_closed (m : ModuleIR)
    (hwf : ∀ a ∈ m.decls, ∀ b ∈ m.uses a, b ∈ m.decls)
    {e d : DeclId} (he : e ∈ m.decls) (hpath : UsesStar m.uses e d)
    (hd : d ∈ reverseDefUseClosure m) :
    e ∈ reverseDefUseClosure m := by
  induction hpath with
  | refl _ => exact hd
  | step hab _ ih =>
    have hb_decl : _ ∈ m.decls := hwf _ he _ hab
    have hb_closed := ih hb_decl hd
    exact reverseDefUseClosure_closed m _ he _ hab hb_closed

/-- Precision direction: every declaration in `expandReverseOnce m S` either was in `S` or reaches `S`. -/
private theorem expandReverseOnce_reaches_seed (m : ModuleIR) (S : List DeclId)
    (hS : ∀ z ∈ S, ∃ d ∈ seedChangedDecls m, UsesStar m.uses z d) :
    ∀ x ∈ expandReverseOnce m S, ∃ d ∈ seedChangedDecls m, UsesStar m.uses x d := by
  intro x hx
  rcases (mem_expandReverseOnce m S x).mp hx with hxS | ⟨_, y, hy, hyS⟩
  · exact hS x hxS
  · rcases hS y hyS with ⟨d, hd, hpath⟩
    exact ⟨d, hd, UsesStar.step hy hpath⟩

private theorem expandReverseN_reaches_seed (m : ModuleIR) (k : Nat) (S : List DeclId)
    (hS : ∀ z ∈ S, ∃ d ∈ seedChangedDecls m, UsesStar m.uses z d) :
    ∀ x ∈ expandReverseN m k S, ∃ d ∈ seedChangedDecls m, UsesStar m.uses x d := by
  induction k generalizing S with
  | zero => exact hS
  | succ k ih =>
    exact ih (expandReverseOnce m S) (expandReverseOnce_reaches_seed m S hS)

private theorem mem_seedChangedDecls_iff (m : ModuleIR) (d : DeclId) :
    d ∈ seedChangedDecls m ↔ d ∈ m.decls ∧ HunkAttribution.inDecl d ∈ m.hunks := by
  unfold seedChangedDecls
  rw [List.mem_filterMap]
  constructor
  · rintro ⟨h, hh, hmatch⟩
    cases h with
    | unattributed => simp at hmatch
    | inDecl d' =>
      simp only at hmatch
      split at hmatch
      · injection hmatch with hEq
        subst hEq
        exact ⟨List.contains_iff_mem.mp ‹_›, hh⟩
      · simp at hmatch
  · rintro ⟨hd, hh⟩
    refine ⟨HunkAttribution.inDecl d, hh, ?_⟩
    simp [hd]

/-! ### Main Public Soundness & Precision Theorems -/

/--
**Theorem 1 (Impure Top-Level Safety):**
If a non-empty edit touches a module with top-level side effects (`isPureTopLevel = false`),
`attributeModuleHunks` MUST return `complete = false` so the planner widens conservatively.
-/
theorem impure_module_widens_conservatively (m : ModuleIR)
    (hnonempty : m.hunks.isEmpty = false)
    (himpure : m.isPureTopLevel = false) :
    (attributeModuleHunks m).complete = false := by
  unfold attributeModuleHunks
  simp [hnonempty, himpure]

/--
**Theorem 2 (Unattributed Hunk Safety):**
If any changed hunk falls outside known pure declarations (`unattributed` or unknown `DeclId`),
`attributeModuleHunks` MUST return `complete = false` so the planner widens conservatively.
-/
theorem unattributed_hunk_widens_conservatively (m : ModuleIR)
    (hunattr : HunkAttribution.unattributed ∈ m.hunks) :
    (attributeModuleHunks m).complete = false := by
  have hnonempty : m.hunks.isEmpty = false := by
    cases h : m.hunks with
    | nil => simp [h] at hunattr
    | cons _ _ => rfl
  have hall : allHunksInKnownDecls m = false := by
    unfold allHunksInKnownDecls
    rw [List.all_eq_false]
    exact ⟨HunkAttribution.unattributed, hunattr, by simp⟩
  unfold attributeModuleHunks
  simp [hnonempty, hall]

/--
**Theorem 3 (Private-Helper Attribution Soundness):**
For any well-formed pure top-level module where every changed hunk is attributed to a
declaration (exported or private), EVERY exported symbol `sym` that transitively depends
on a changed private helper or export is guaranteed to appear in `(attributeModuleHunks m).exports`.
-/
theorem private_helper_attribution_sound (m : ModuleIR)
    (hwf : ∀ a ∈ m.decls, ∀ b ∈ m.uses a, b ∈ m.decls)
    (hpure : m.isPureTopLevel = true)
    (hattr : allHunksInKnownDecls m = true)
    (sym : Symbol)
    (hobs : ExportMayObserveHunk m sym) :
    sym ∈ (attributeModuleHunks m).exports := by
  rcases hobs with ⟨e, he, hexp, d, hd, hhunk, hpath⟩
  have hnonempty : m.hunks.isEmpty = false := by
    cases h : m.hunks with
    | nil => simp [h] at hhunk
    | cons _ _ => rfl
  have hd_seed : d ∈ seedChangedDecls m := (mem_seedChangedDecls_iff m d).mpr ⟨hd, hhunk⟩
  have hd_closed : d ∈ reverseDefUseClosure m :=
    mem_expandReverseN_mono m m.decls.length (seedChangedDecls m) d hd_seed
  have he_closed : e ∈ reverseDefUseClosure m :=
    reverseDefUseClosure_backwards_closed m hwf he hpath hd_closed
  unfold attributeModuleHunks
  simp only [hnonempty, hpure, hattr, Bool.false_eq_true, Bool.not_true, Bool.or_self, ↓reduceIte]
  rw [List.mem_filterMap]
  refine ⟨e, he, ?_⟩
  simp [he_closed, hexp]

/--
**Theorem 4 (Private-Helper Attribution Precision — No Spurious Exports):**
Every exported symbol emitted by `attributeModuleHunks m` on a pure, fully attributed module
genuinely has a transitive intra-file def-use path to a changed declaration.
-/
theorem private_helper_attribution_precise (m : ModuleIR)
    (hpure : m.isPureTopLevel = true)
    (hattr : allHunksInKnownDecls m = true)
    (sym : Symbol)
    (hmem : sym ∈ (attributeModuleHunks m).exports) :
    ExportMayObserveHunk m sym := by
  unfold attributeModuleHunks at hmem
  by_cases hempty : m.hunks.isEmpty = true
  · simp [hempty] at hmem
  · simp only [hempty, hpure, hattr, Bool.false_eq_true, Bool.not_true, Bool.or_self, ↓reduceIte] at hmem
    rw [List.mem_filterMap] at hmem
    rcases hmem with ⟨e, he, hmatch⟩
    split at hmatch
    · have he_closed : e ∈ reverseDefUseClosure m := List.contains_iff_mem.mp ‹_›
      have hreach := expandReverseN_reaches_seed m m.decls.length (seedChangedDecls m)
        (fun z hz => ⟨z, hz, UsesStar.refl z⟩) e he_closed
      rcases hreach with ⟨d, hd_seed, hpath⟩
      rcases (mem_seedChangedDecls_iff m d).mp hd_seed with ⟨hd_decl, hhunk⟩
      exact ⟨e, he, hmatch, d, hd_decl, hhunk, hpath⟩
    · simp at hmatch

/--
**Theorem 5 (Exact `↔` Characterization for Private-Helper Attribution):**
On any well-formed pure top-level module with attributed hunks, the emitted export set is
BOTH sound AND exact: `sym` is attributed if and only if `sym` transitively observes a hunk.
-/
theorem private_helper_attribution_exact_iff (m : ModuleIR)
    (hwf : ∀ a ∈ m.decls, ∀ b ∈ m.uses a, b ∈ m.decls)
    (hpure : m.isPureTopLevel = true)
    (hattr : allHunksInKnownDecls m = true)
    (sym : Symbol) :
    sym ∈ (attributeModuleHunks m).exports ↔ ExportMayObserveHunk m sym :=
  ⟨private_helper_attribution_precise m hpure hattr sym,
   private_helper_attribution_sound m hwf hpure hattr sym⟩

end DadTest
