import DadTest.Types
import DadTest.Planner

namespace DadTest

/-- Normalized SQL object identifier (e.g. `"public.maintenance_assets"`, `"public.orders"`). -/
abbrev SqlObject := String

/--
Dependency edge in the database schema graph (foreign keys in both directions,
views depending on base tables, triggers/functions/RLS policies referencing tables).
-/
structure SqlDepEdge where
  fromObj : SqlObject
  toObj : SqlObject
  deriving DecidableEq, Repr

/-- Database schema dependency graph across a workspace. -/
structure SqlSchemaGraph where
  objects : List SqlObject
  edges : List SqlDepEdge
  deriving DecidableEq, Repr

/--
Classification of a single changed SQL/migration artifact:
- `scoped touched`: every DDL statement was parsed and proved to touch ONLY `touched`.
- `globalDdl`: any unparseable SQL, `CREATE EXTENSION`, `ALTER ROLE`, `CREATE PUBLICATION`,
  `CREATE/ALTER TYPE`, `ALTER DATABASE`, dynamic `EXECUTE`, or unrecognized DDL.
-/
inductive MigrationDdl where
  | scopedTables (touched : List SqlObject)
  | globalDdl
  deriving DecidableEq, Repr

/-- Database-facing metadata for a task (e.g. a Postgres integration suite). -/
structure DbTaskSpec where
  taskId : TaskId
  /-- True for migration-boot/schema-verification suites that must run on ANY migration change. -/
  isMigrationRunner : Bool
  /-- Normalized SQL objects owned or queried by this task's project. -/
  referencedObjects : List SqlObject
  /-- True when the project contains raw/dynamic SQL whose referenced tables cannot be bounded. -/
  hasUnmappedSql : Bool
  deriving DecidableEq, Repr

/--
Symmetric/bidirectional adjacency step: if `edge` connects `a` and `b` in either direction
(so FK parent↔child, view↔table, trigger↔table propagation cannot miss a cascade or constraint),
`SqlStep edges a b` holds.
-/
def SqlStep (edges : List SqlDepEdge) (a b : SqlObject) : Prop :=
  (∃ e ∈ edges, e.fromObj = a ∧ e.toObj = b) ∨
  (∃ e ∈ edges, e.toObj = a ∧ e.fromObj = b)

/-- Reflexive-transitive reachability over the bidirectional SQL dependency graph. -/
inductive SqlReachable (edges : List SqlDepEdge) : SqlObject → SqlObject → Prop where
  | refl (o : SqlObject) : SqlReachable edges o o
  | step {a b c : SqlObject} :
      SqlStep edges a b →
      SqlReachable edges b c →
      SqlReachable edges a c

theorem SqlReachable.trans {edges : List SqlDepEdge} {a b c : SqlObject}
    (hab : SqlReachable edges a b) (hbc : SqlReachable edges b c) :
    SqlReachable edges a c := by
  induction hab with
  | refl _ => exact hbc
  | step h _ ih => exact SqlReachable.step h (ih hbc)

theorem SqlReachable.snoc {edges : List SqlDepEdge} {a b c : SqlObject}
    (hab : SqlReachable edges a b) (hbc : SqlStep edges b c) :
    SqlReachable edges a c :=
  hab.trans (SqlReachable.step hbc (SqlReachable.refl c))

/--
Ground-truth semantic relation: a DB task `t` may be affected by `changes` iff `changes` is
non-empty AND at least one of the following holds:
  1. `t` is a migration-boot runner (`isMigrationRunner = true`)
  2. `t` executes unmapped/dynamic SQL (`hasUnmappedSql = true`)
  3. any change is `globalDdl` (unrecognized/global DDL widens to ALL DB tasks)
  4. some touched SQL object reaches an object in `t.referencedObjects` via bidirectional
     FK/view/trigger/function edges.
-/
def DbTaskMayBeAffected (schema : SqlSchemaGraph) (changes : List MigrationDdl) (t : DbTaskSpec) : Prop :=
  changes ≠ [] ∧
  (t.isMigrationRunner = true ∨
   t.hasUnmappedSql = true ∨
   MigrationDdl.globalDdl ∈ changes ∨
   ∃ touched, MigrationDdl.scopedTables touched ∈ changes ∧
     ∃ src ∈ touched, ∃ dst ∈ t.referencedObjects,
       src ∈ schema.objects ∧ dst ∈ schema.objects ∧ SqlReachable schema.edges src dst)

/-- One bidirectional expansion step in the SQL schema graph. -/
def expandSqlOnce (schema : SqlSchemaGraph) (reached : List SqlObject) : List SqlObject :=
  let next := schema.objects.filter (fun o =>
    schema.edges.any (fun e =>
      (e.toObj == o && reached.contains e.fromObj) ||
      (e.fromObj == o && reached.contains e.toObj)))
  next.foldl (fun acc o => if acc.contains o then acc else o :: acc) reached

/-- Bounded fixed-point iteration over `schema.objects.length` steps. -/
def expandSqlN (schema : SqlSchemaGraph) : Nat → List SqlObject → List SqlObject
  | 0, reached => reached
  | n + 1, reached => expandSqlN schema n (expandSqlOnce schema reached)

/-- Seed SQL objects touched by scoped migration changes (filtered to known schema objects). -/
def seedSqlObjects (schema : SqlSchemaGraph) (changes : List MigrationDdl) : List SqlObject :=
  changes.flatMap (fun c =>
    match c with
    | MigrationDdl.scopedTables touched => touched.filter (fun o => schema.objects.contains o)
    | MigrationDdl.globalDdl => [])

/-- Full transitive SQL object closure from `changes`. -/
def sqlImpactClosure (schema : SqlSchemaGraph) (changes : List MigrationDdl) : List SqlObject :=
  expandSqlN schema schema.objects.length (seedSqlObjects schema changes)

/-- Whether any migration change is `globalDdl` (or touches an object unknown to `schema.objects`). -/
def hasGlobalSqlUncertainty (schema : SqlSchemaGraph) (changes : List MigrationDdl) : Bool :=
  changes.any (fun c =>
    match c with
    | MigrationDdl.globalDdl => true
    | MigrationDdl.scopedTables touched => touched.any (fun o => !schema.objects.contains o))

/-- Executable decision predicate for one DB task. -/
def shouldRunDbTask (schema : SqlSchemaGraph) (changes : List MigrationDdl) (t : DbTaskSpec) : Bool :=
  if changes.isEmpty then
    false
  else if t.isMigrationRunner || t.hasUnmappedSql || hasGlobalSqlUncertainty schema changes then
    true
  else
    let closed := sqlImpactClosure schema changes
    t.referencedObjects.any (fun dst => closed.contains dst)

/-- Executable SQL/migration planner returning the selected DB task IDs. -/
def selectDbTasks (schema : SqlSchemaGraph) (changes : List MigrationDdl) (tasks : List DbTaskSpec) : List TaskId :=
  tasks.filterMap (fun t => if shouldRunDbTask schema changes t then some t.taskId else none)

/-! ### Internal helper lemmas -/

private theorem mem_foldl_dedup_sql (xs acc : List SqlObject) (x : SqlObject) :
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

private theorem mem_expandSqlOnce (schema : SqlSchemaGraph) (reached : List SqlObject) (x : SqlObject) :
    x ∈ expandSqlOnce schema reached ↔
      x ∈ reached ∨ (x ∈ schema.objects ∧ ∃ y ∈ reached, SqlStep schema.edges y x) := by
  unfold expandSqlOnce SqlStep
  rw [mem_foldl_dedup_sql]
  simp only [List.mem_filter, List.any_eq_true, Bool.or_eq_true, Bool.and_eq_true,
    beq_iff_eq, List.contains_iff_mem]
  constructor
  · rintro (hx | ⟨hxobj, e, he, (⟨rfl, hfrom⟩ | ⟨rfl, hto⟩)⟩)
    · exact Or.inl hx
    · exact Or.inr ⟨hxobj, e.fromObj, hfrom, Or.inl ⟨e, he, rfl, rfl⟩⟩
    · exact Or.inr ⟨hxobj, e.toObj, hto, Or.inr ⟨e, he, rfl, rfl⟩⟩
  · rintro (hx | ⟨hxobj, y, hy, (⟨e, he, rfl, rfl⟩ | ⟨e, he, rfl, rfl⟩)⟩)
    · exact Or.inl hx
    · exact Or.inr ⟨hxobj, e, he, Or.inl ⟨rfl, hy⟩⟩
    · exact Or.inr ⟨hxobj, e, he, Or.inr ⟨rfl, hy⟩⟩

private theorem mem_expandSqlN_mono (schema : SqlSchemaGraph) (k : Nat) (reached : List SqlObject) (x : SqlObject)
    (hx : x ∈ reached) : x ∈ expandSqlN schema k reached := by
  induction k generalizing reached with
  | zero => exact hx
  | succ k ih =>
    apply ih
    exact (mem_expandSqlOnce schema reached x).mpr (Or.inl hx)

private theorem expandSqlN_fixed_if_once_fixed (schema : SqlSchemaGraph) (k : Nat) (S : List SqlObject)
    (hfixed : ∀ x, x ∈ expandSqlOnce schema S → x ∈ S) :
    ∀ x, x ∈ expandSqlN schema k S → x ∈ S := by
  induction k generalizing S with
  | zero => intro x hx; exact hx
  | succ k ih =>
    intro x hx
    have hstep : ∀ z, z ∈ expandSqlOnce schema (expandSqlOnce schema S) → z ∈ expandSqlOnce schema S := by
      intro z hz
      rcases (mem_expandSqlOnce schema (expandSqlOnce schema S) z).mp hz with hz1 | ⟨hobj, y, hy1, hst⟩
      · exact hz1
      · exact (mem_expandSqlOnce schema S z).mpr (Or.inr ⟨hobj, y, hfixed y hy1, hst⟩)
    exact hfixed x (ih (expandSqlOnce schema S) hstep x hx)

private def missingSqlCount (objs S : List SqlObject) : Nat :=
  (objs.filter (fun o => !S.contains o)).length

private theorem filter_len_lt {α : Type} [BEq α] [LawfulBEq α]
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

private theorem expandSqlN_reaches_fixpoint (schema : SqlSchemaGraph) (k : Nat) (S : List SqlObject)
    (hbound : missingSqlCount schema.objects S ≤ k) :
    ∀ x, x ∈ expandSqlOnce schema (expandSqlN schema k S) → x ∈ expandSqlN schema k S := by
  induction k generalizing S with
  | zero =>
    have hzero : missingSqlCount schema.objects S = 0 := Nat.eq_zero_of_le_zero hbound
    intro x hx
    rcases (mem_expandSqlOnce schema S x).mp hx with hS | ⟨hxobj, _⟩
    · exact hS
    · by_cases hmem : S.contains x
      · exact List.contains_iff_mem.mp hmem
      · exfalso
        have hpos : 0 < missingSqlCount schema.objects S := by
          unfold missingSqlCount
          apply List.length_pos_of_mem (a := x)
          rw [List.mem_filter]
          exact ⟨hxobj, by simp; exact fun hm => hmem (List.contains_iff_mem.mpr hm)⟩
        omega
  | succ k ih =>
    by_cases hfixed : (expandSqlOnce schema S).all (fun z => S.contains z) = true
    · have hfix : ∀ x, x ∈ expandSqlOnce schema S → x ∈ S := by
        intro x hx
        exact List.contains_iff_mem.mp (List.all_eq_true.mp hfixed x hx)
      intro x hx
      have hstep : ∀ z, z ∈ expandSqlN schema (k + 1) S → z ∈ S :=
        expandSqlN_fixed_if_once_fixed schema (k + 1) S hfix
      have hS : x ∈ S := by
        rcases (mem_expandSqlOnce schema (expandSqlN schema (k + 1) S) x).mp hx with h1 | ⟨hobj, y, hy1, hst⟩
        · exact hstep x h1
        · exact hfix x ((mem_expandSqlOnce schema S x).mpr (Or.inr ⟨hobj, y, hstep y hy1, hst⟩))
      exact mem_expandSqlN_mono schema (k + 1) S x hS
    · have hfalse : (expandSqlOnce schema S).all (fun z => S.contains z) = false :=
        Bool.eq_false_iff.mpr hfixed
      rcases List.all_eq_false.mp hfalse with ⟨w, hw1, hwNot⟩
      have hwS : w ∉ S := fun hm => hwNot (List.contains_iff_mem.mpr hm)
      have hwobj : w ∈ schema.objects := by
        rcases (mem_expandSqlOnce schema S w).mp hw1 with h | ⟨hobj, _⟩
        · exact absurd h hwS
        · exact hobj
      have hlt : missingSqlCount schema.objects (expandSqlOnce schema S) < missingSqlCount schema.objects S := by
        unfold missingSqlCount
        apply filter_len_lt
        · intro a _ hq
          simp only [Bool.not_eq_true'] at hq ⊢
          cases hpa : S.contains a
          · rfl
          · have hmem : a ∈ S := List.contains_iff_mem.mp hpa
            have hmem1 : a ∈ expandSqlOnce schema S := (mem_expandSqlOnce schema S a).mpr (Or.inl hmem)
            have hc : (expandSqlOnce schema S).contains a = true := List.contains_iff_mem.mpr hmem1
            rw [hc] at hq
            simp at hq
        · refine ⟨w, hwobj, ?_, ?_⟩
          · simp [hwS]
          · simp [hw1]
      exact ih (expandSqlOnce schema S) (by omega)

private theorem sqlImpactClosure_closed (schema : SqlSchemaGraph) (changes : List MigrationDdl) :
    ∀ x ∈ schema.objects, ∀ y ∈ sqlImpactClosure schema changes,
      SqlStep schema.edges y x → x ∈ sqlImpactClosure schema changes := by
  intro x hx y hy hst
  unfold sqlImpactClosure at hy ⊢
  apply expandSqlN_reaches_fixpoint schema schema.objects.length (seedSqlObjects schema changes)
    (List.length_filter_le _ _)
  exact (mem_expandSqlOnce schema _ x).mpr (Or.inr ⟨hx, y, hy, hst⟩)

private theorem sqlImpactClosure_forward_closed (schema : SqlSchemaGraph) (changes : List MigrationDdl)
    (hwf : ∀ e ∈ schema.edges, e.fromObj ∈ schema.objects ∧ e.toObj ∈ schema.objects)
    {src dst : SqlObject} (hsrc : src ∈ sqlImpactClosure schema changes)
    (hreach : SqlReachable schema.edges src dst) :
    dst ∈ sqlImpactClosure schema changes := by
  induction hreach with
  | refl _ => exact hsrc
  | @step _ b _ hst _ ih =>
    have hb_obj : b ∈ schema.objects := by
      rcases hst with ⟨e, he, _, rfl⟩ | ⟨e, he, _, rfl⟩
      · exact (hwf e he).2
      · exact (hwf e he).1
    exact ih (sqlImpactClosure_closed schema changes b hb_obj _ hsrc hst)

private theorem expandSqlOnce_reaches_from_seed (schema : SqlSchemaGraph) (changes : List MigrationDdl)
    (S : List SqlObject)
    (hS : ∀ z ∈ S, ∃ src ∈ seedSqlObjects schema changes, SqlReachable schema.edges src z) :
    ∀ x ∈ expandSqlOnce schema S,
      ∃ src ∈ seedSqlObjects schema changes, SqlReachable schema.edges src x := by
  intro x hx
  rcases (mem_expandSqlOnce schema S x).mp hx with hxS | ⟨_, y, hyS, hst⟩
  · exact hS x hxS
  · rcases hS y hyS with ⟨src, hsrc, hreach⟩
    exact ⟨src, hsrc, hreach.snoc hst⟩

private theorem expandSqlN_reaches_from_seed (schema : SqlSchemaGraph) (changes : List MigrationDdl)
    (k : Nat) (S : List SqlObject)
    (hS : ∀ z ∈ S, ∃ src ∈ seedSqlObjects schema changes, SqlReachable schema.edges src z) :
    ∀ x ∈ expandSqlN schema k S,
      ∃ src ∈ seedSqlObjects schema changes, SqlReachable schema.edges src x := by
  induction k generalizing S with
  | zero => exact hS
  | succ k ih =>
    exact ih (expandSqlOnce schema S) (expandSqlOnce_reaches_from_seed schema changes S hS)

private theorem mem_seedSqlObjects_iff (schema : SqlSchemaGraph) (changes : List MigrationDdl) (o : SqlObject) :
    o ∈ seedSqlObjects schema changes ↔
      o ∈ schema.objects ∧ ∃ touched, MigrationDdl.scopedTables touched ∈ changes ∧ o ∈ touched := by
  unfold seedSqlObjects
  rw [List.mem_flatMap]
  constructor
  · rintro ⟨c, hc, hmem⟩
    cases c with
    | globalDdl => simp at hmem
    | scopedTables touched =>
      rw [List.mem_filter] at hmem
      exact ⟨List.contains_iff_mem.mp hmem.2, touched, hc, hmem.1⟩
  · rintro ⟨ho, touched, hc, ht⟩
    refine ⟨MigrationDdl.scopedTables touched, hc, ?_⟩
    rw [List.mem_filter]
    exact ⟨ht, List.contains_iff_mem.mpr ho⟩

private theorem expandSqlOnce_subset_objects (schema : SqlSchemaGraph) (S : List SqlObject)
    (hS : ∀ x ∈ S, x ∈ schema.objects) :
    ∀ x ∈ expandSqlOnce schema S, x ∈ schema.objects := by
  intro x hx
  rcases (mem_expandSqlOnce schema S x).mp hx with hxS | ⟨hxobj, _⟩
  · exact hS x hxS
  · exact hxobj

private theorem expandSqlN_subset_objects (schema : SqlSchemaGraph) (k : Nat) (S : List SqlObject)
    (hS : ∀ x ∈ S, x ∈ schema.objects) :
    ∀ x ∈ expandSqlN schema k S, x ∈ schema.objects := by
  induction k generalizing S with
  | zero => exact hS
  | succ k ih =>
    exact ih (expandSqlOnce schema S) (expandSqlOnce_subset_objects schema S hS)

private theorem sqlImpactClosure_subset_objects (schema : SqlSchemaGraph) (changes : List MigrationDdl) :
    ∀ x ∈ sqlImpactClosure schema changes, x ∈ schema.objects := by
  unfold sqlImpactClosure
  apply expandSqlN_subset_objects
  intro x hx
  exact ((mem_seedSqlObjects_iff schema changes x).mp hx).1

/-! ### Main Public SQL / Migration Soundness & Precision Theorems -/

/--
**Theorem 1 (Migration Runner Always Selected):**
Whenever any migration changes exist (`changes ≠ []`), every migration-boot task
(`isMigrationRunner = true`) MUST be selected so the full migration chain is always tested.
-/
theorem sql_migration_runner_always_selected (schema : SqlSchemaGraph)
    (changes : List MigrationDdl) (tasks : List DbTaskSpec) (t : DbTaskSpec)
    (hnonempty : changes ≠ [])
    (ht : t ∈ tasks) (hrunner : t.isMigrationRunner = true) :
    t.taskId ∈ selectDbTasks schema changes tasks := by
  have hempty : changes.isEmpty = false := by
    cases changes with
    | nil => exact absurd rfl hnonempty
    | cons _ _ => rfl
  unfold selectDbTasks
  rw [List.mem_filterMap]
  refine ⟨t, ht, ?_⟩
  unfold shouldRunDbTask
  simp [hempty, hrunner]

/--
**Theorem 2 (Global DDL Widens All DB Tasks):**
Any unrecognized or database-wide DDL (`MigrationDdl.globalDdl`) widens to EVERY DB task.
-/
theorem sql_global_ddl_widens_all_db_tasks (schema : SqlSchemaGraph)
    (changes : List MigrationDdl) (tasks : List DbTaskSpec) (t : DbTaskSpec)
    (hglobal : MigrationDdl.globalDdl ∈ changes) (ht : t ∈ tasks) :
    t.taskId ∈ selectDbTasks schema changes tasks := by
  have hempty : changes.isEmpty = false := by
    cases changes with
    | nil => simp at hglobal
    | cons _ _ => rfl
  have hunc : hasGlobalSqlUncertainty schema changes = true := by
    unfold hasGlobalSqlUncertainty
    rw [List.any_eq_true]
    exact ⟨MigrationDdl.globalDdl, hglobal, rfl⟩
  unfold selectDbTasks
  rw [List.mem_filterMap]
  refine ⟨t, ht, ?_⟩
  unfold shouldRunDbTask
  simp [hempty, hunc]

/--
**Theorem 3 (Unmapped SQL Fails Closed):**
Any project with raw/dynamic SQL (`hasUnmappedSql = true`) always runs when migrations change.
-/
theorem sql_unmapped_project_widens_conservatively (schema : SqlSchemaGraph)
    (changes : List MigrationDdl) (tasks : List DbTaskSpec) (t : DbTaskSpec)
    (hnonempty : changes ≠ []) (ht : t ∈ tasks) (hunmapped : t.hasUnmappedSql = true) :
    t.taskId ∈ selectDbTasks schema changes tasks := by
  have hempty : changes.isEmpty = false := by
    cases changes with
    | nil => exact absurd rfl hnonempty
    | cons _ _ => rfl
  unfold selectDbTasks
  rw [List.mem_filterMap]
  refine ⟨t, ht, ?_⟩
  unfold shouldRunDbTask
  simp [hempty, hunmapped]

/--
**Theorem 4 (SQL Migration Soundness — Zero False Skips):**
For any well-formed SQL schema graph, if a DB task `t` may be affected by `changes`
(directly, via bidirectional FK/view/trigger/function closure, via global DDL, as a
migration runner, or via unmapped SQL), `selectDbTasks` is guaranteed to select `t`.
-/
theorem sql_no_false_migration_skips (schema : SqlSchemaGraph)
    (hwf : ∀ e ∈ schema.edges, e.fromObj ∈ schema.objects ∧ e.toObj ∈ schema.objects)
    (changes : List MigrationDdl) (tasks : List DbTaskSpec) (t : DbTaskSpec)
    (ht : t ∈ tasks)
    (haff : DbTaskMayBeAffected schema changes t) :
    t.taskId ∈ selectDbTasks schema changes tasks := by
  rcases haff with ⟨hnonempty, hrunner | hunmapped | hglobal | ⟨touched, hscoped, src, hsrc_t, dst, hdst_ref, hsrc_obj, _, hreach⟩⟩
  · exact sql_migration_runner_always_selected schema changes tasks t hnonempty ht hrunner
  · exact sql_unmapped_project_widens_conservatively schema changes tasks t hnonempty ht hunmapped
  · exact sql_global_ddl_widens_all_db_tasks schema changes tasks t hglobal ht
  · have hempty : changes.isEmpty = false := by
      cases changes with
      | nil => exact absurd rfl hnonempty
      | cons _ _ => rfl
    have hsrc_seed : src ∈ seedSqlObjects schema changes :=
      (mem_seedSqlObjects_iff schema changes src).mpr ⟨hsrc_obj, touched, hscoped, hsrc_t⟩
    have hsrc_closed : src ∈ sqlImpactClosure schema changes :=
      mem_expandSqlN_mono schema schema.objects.length (seedSqlObjects schema changes) src hsrc_seed
    have hdst_closed : dst ∈ sqlImpactClosure schema changes :=
      sqlImpactClosure_forward_closed schema changes hwf hsrc_closed hreach
    unfold selectDbTasks
    rw [List.mem_filterMap]
    refine ⟨t, ht, ?_⟩
    unfold shouldRunDbTask
    simp only [hempty, Bool.false_eq_true, ↓reduceIte]
    split
    · rfl
    · have hany : t.referencedObjects.any (fun d => (sqlImpactClosure schema changes).contains d) = true :=
        List.any_eq_true.mpr ⟨dst, hdst_ref, List.contains_iff_mem.mpr hdst_closed⟩
      rw [hany]
      rfl

/--
**Theorem 5 (Exact `↔` Precision When All Scoped Objects Are Known to `schema.objects`):**
Unrelated domains whose referenced SQL objects are disjoint from the transitive FK/view/trigger
closure are NEVER spuriously selected.
-/
theorem sql_select_exact_iff (schema : SqlSchemaGraph)
    (hwf : ∀ e ∈ schema.edges, e.fromObj ∈ schema.objects ∧ e.toObj ∈ schema.objects)
    (changes : List MigrationDdl)
    (hknown : ∀ touched, MigrationDdl.scopedTables touched ∈ changes → ∀ o ∈ touched, o ∈ schema.objects)
    (t : DbTaskSpec) :
    shouldRunDbTask schema changes t = true ↔ DbTaskMayBeAffected schema changes t := by
  constructor
  · intro hrun
    unfold shouldRunDbTask at hrun
    cases hch : changes with
    | nil => simp [hch] at hrun
    | cons c cs =>
      have hnonempty : c :: cs ≠ [] := List.cons_ne_nil c cs
      simp only [hch, List.isEmpty_cons, Bool.false_eq_true, ↓reduceIte] at hrun
      refine ⟨hnonempty, ?_⟩
      by_cases htop : (t.isMigrationRunner || t.hasUnmappedSql || hasGlobalSqlUncertainty schema (c :: cs)) = true
      · simp only [Bool.or_eq_true] at htop
        rcases htop with (hrunner | hunmapped) | hglobal
        · exact Or.inl hrunner
        · exact Or.inr (Or.inl hunmapped)
        · unfold hasGlobalSqlUncertainty at hglobal
          rw [List.any_eq_true] at hglobal
          rcases hglobal with ⟨ch, hch_mem, hch_bad⟩
          cases ch with
          | globalDdl => exact Or.inr (Or.inr (Or.inl hch_mem))
          | scopedTables touched =>
            rw [List.any_eq_true] at hch_bad
            rcases hch_bad with ⟨o, ho_t, ho_not⟩
            have hmem' : MigrationDdl.scopedTables touched ∈ changes := by rw [hch]; exact hch_mem
            have ho_in : o ∈ schema.objects := hknown touched hmem' o ho_t
            simp [ho_in] at ho_not
      · rw [ite_eq_right htop, List.any_eq_true] at hrun
        rcases hrun with ⟨dst, hdst_ref, hdst_c⟩
        have hdst_closed : dst ∈ sqlImpactClosure schema (c :: cs) := List.contains_iff_mem.mp hdst_c
        have hdst_obj : dst ∈ schema.objects := sqlImpactClosure_subset_objects schema (c :: cs) dst hdst_closed
        have hreach := expandSqlN_reaches_from_seed schema (c :: cs) schema.objects.length
          (seedSqlObjects schema (c :: cs))
          (fun z hz => ⟨z, hz, SqlReachable.refl z⟩) dst hdst_closed
        rcases hreach with ⟨src, hsrc_seed, hpath⟩
        rcases (mem_seedSqlObjects_iff schema (c :: cs) src).mp hsrc_seed with ⟨hsrc_obj, touched, hscoped, hsrc_t⟩
        exact Or.inr (Or.inr (Or.inr ⟨touched, hscoped, src, hsrc_t, dst, hdst_ref, hsrc_obj, hdst_obj, hpath⟩))
  · intro haff
    have hmem := sql_no_false_migration_skips schema hwf changes [t] t (List.mem_cons_self ..) haff
    unfold selectDbTasks at hmem
    rw [List.mem_filterMap] at hmem
    rcases hmem with ⟨t', ht', hmatch⟩
    rw [List.mem_singleton] at ht'
    subst ht'
    split at hmatch
    · assumption
    · simp at hmatch

/--
**Theorem 6 (Combined JS + SQL Union Soundness):**
Combining the existing JS/TS planner (`buildPlan`) with the SQL/migration planner (`selectDbTasks`)
by taking their union guarantees zero false skips across BOTH channels simultaneously:
any task affected by EITHER a JS/TS symbol change OR a SQL/migration change is guaranteed to run.
-/
def combinedSelectedTasks (jsSelected sqlSelected : List TaskId) : List TaskId :=
  jsSelected ++ sqlSelected

theorem combined_js_and_sql_no_false_skips
    (m : Manifest) (g : DepGraph) (changed : List ModuleId)
    (reqFull : Bool) (fuel : Nat)
    (schema : SqlSchemaGraph)
    (hwf : ∀ e ∈ schema.edges, e.fromObj ∈ schema.objects ∧ e.toObj ∈ schema.objects)
    (sqlChanges : List MigrationDdl)
    (dbTasks : List DbTaskSpec)
    {mod : ModuleId} {p : ProjectId} {t : TaskSpec} {dbT : DbTaskSpec}
    (ht : t ∈ m.tasks) (htProj : t.project = p) (htMode : t.impact = .reachability)
    (hdbT : dbT ∈ dbTasks) (hSameId : dbT.taskId = t.id)
    (haff :
      (ImpactedModule g t.channel (changed.filter (fun x => g.modules.contains x)) mod ∧ m.ownerOf mod = some p) ∨
      DbTaskMayBeAffected schema sqlChanges dbT) :
    t.id ∈ combinedSelectedTasks
      (buildPlan m (some g) changed reqFull fuel).selectedTasks
      (selectDbTasks schema sqlChanges dbTasks) := by
  unfold combinedSelectedTasks
  rw [List.mem_append]
  rcases haff with ⟨hImp, hOwner⟩ | hSql
  · exact Or.inl (no_false_task_skips m g changed reqFull fuel hImp hOwner ht htProj htMode)
  · rw [← hSameId]
    exact Or.inr (sql_no_false_migration_skips schema hwf sqlChanges dbTasks dbT hdbT hSql)

end DadTest
