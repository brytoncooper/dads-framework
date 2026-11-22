import DadsAccess.Model

/-!
# Dads Access Semantics (`DadsAccess.Semantics`)

Formal reference semantics for:
1. Tuple expiration (`tupleActive`)
2. Direct primary-key relation checks (`directMember`) vs. recursive userset
   membership (`UsersetMember` inductive + computable `usersetMemberFuel`)
3. Least-fixed-point permission evaluation (`evalPermFuel` / `evalPerm`)
4. Actor-first reverse lookup (`lookupResources` / `compileFilter`)
5. Parent-FK `scopeColumns` filter (`evalScopedFilter`) and branch-pruning
   `resolveFilter` (`evalResolvedFilter`)
-/

namespace DadsAccess

/-- Active at timestamp `now` iff `expiresAt` is `none` or strictly greater than `now`. -/
def tupleActive (now : Timestamp) (t : Tuple) : Bool :=
  match t.expiresAt with
  | none => true
  | some exp => now < exp

/-- All currently active tuples in a store. -/
def activeTuples (store : List Tuple) (now : Timestamp) : List Tuple :=
  store.filter (tupleActive now)

/--
Direct primary-key membership (no userset recursion):
matches `(e, id, rel)` directly to `actor` or wildcard `actor.kind:*`.
Mirrors `directRelationMembershipCheck` in Postgres & SQLite.
-/
def directMember (store : List Tuple) (now : Timestamp) (a : Actor)
    (e : EntityName) (id : ObjId) (r : RelName) : Bool :=
  (activeTuples store now).any (fun t =>
    t.resourceKind == e && t.resourceId == id && t.relation == r &&
    (t.subject == .direct a.kind a.id || t.subject == .wildcard a.kind))

/--
Inductive least-fixed-point userset membership (`WITH RECURSIVE requested` /
`subject_reachable`), exact even in the presence of cyclic `group#member` graphs.
-/
inductive UsersetMember (store : List Tuple) (now : Timestamp) (a : Actor) :
    EntityName → ObjId → RelName → Prop where
  | direct {e id r} :
      directMember store now a e id r = true →
      UsersetMember store now a e id r
  | step {e id r sk sid sr} :
      (∃ t ∈ activeTuples store now,
        t.resourceKind = e ∧ t.resourceId = id ∧ t.relation = r ∧
        t.subject = .subjectSet sk sid sr) →
      UsersetMember store now a sk sid sr →
      UsersetMember store now a e id r

/--
Computable bounded fixed-point for `subject_reachable`: expands all usersets
reachable from `actor` in `k` rounds (`k = store.length + 1` saturates any
finite tuple graph, including arbitrary cycles).
-/
def subjectReachableStep (active : List Tuple)
    (reached : List (EntityName × ObjId × RelName)) :
    List (EntityName × ObjId × RelName) :=
  let next := active.filterMap (fun t =>
    match t.subject with
    | .subjectSet sk sid sr =>
        if reached.contains (sk, sid, sr) then
          some (t.resourceKind, t.resourceId, t.relation)
        else
          none
    | _ => none)
  (reached ++ next).eraseDups

def subjectReachableFuel (active : List Tuple) (a : Actor) :
    Nat → List (EntityName × ObjId × RelName)
  | 0 =>
      (active.filterMap (fun t =>
        if t.subject == .direct a.kind a.id || t.subject == .wildcard a.kind then
          some (t.resourceKind, t.resourceId, t.relation)
        else
          none)).eraseDups
  | n + 1 =>
      subjectReachableStep active (subjectReachableFuel active a n)

/-- Saturating computable userset reachability for a finite tuple store. -/
def subjectReachable (store : List Tuple) (now : Timestamp) (a : Actor) :
    List (EntityName × ObjId × RelName) :=
  let active := activeTuples store now
  subjectReachableFuel active a active.length

/-- Computable userset membership check (`(e, id, r) ∈ subjectReachable`). -/
def usersetMember (store : List Tuple) (now : Timestamp) (a : Actor)
    (e : EntityName) (id : ObjId) (r : RelName) : Bool :=
  (subjectReachable store now a).contains (e, id, r)

/-- Active direct entity edges from `(e, id)` along relation `rel`. -/
def directEntityEdges (store : List Tuple) (now : Timestamp)
    (e : EntityName) (id : ObjId) (rel : RelName) : List (EntityName × ObjId) :=
  (activeTuples store now).filterMap (fun t =>
    if t.resourceKind == e && t.resourceId == id && t.relation == rel then
      match t.subject with
      | .direct sk sid => some (sk, sid)
      | _ => none
    else
      none)

/-- Candidate resource IDs of kind `e` that appear in `store`. -/
def allResourceIds (store : List Tuple) (e : EntityName) : List ObjId :=
  (store.filterMap (fun t =>
    if t.resourceKind == e then some t.resourceId else none)).eraseDups

/--
Evaluates a permission expression given an interpretation `permVal` of all
permissions `(entity, objId, perm) → Bool` (used for both stratified evaluation
and Knaster-Tarski fixed-point iteration).
-/
def evalExprWith (store : List Tuple) (now : Timestamp) (a : Actor)
    (permVal : EntityName → ObjId → PermName → Bool)
    (e : EntityName) (id : ObjId) : Expr → Bool
  | .rel r => usersetMember store now a e id r
  | .anyOf cs => cs.any (evalExprWith store now a permVal e id)
  | .allOf cs => cs.all (evalExprWith store now a permVal e id)
  | .exclude inc exc =>
      evalExprWith store now a permVal e id inc &&
      !(evalExprWith store now a permVal e id exc)
  | .through rel targets =>
      (directEntityEdges store now e id rel).any (fun (sk, sid) =>
        targets.any (fun tgt => tgt.entity == sk && permVal tgt.entity sid tgt.perm))
  | .throughAll rel targets =>
      let edges := directEntityEdges store now e id rel
      !edges.isEmpty &&
      edges.all (fun (sk, sid) =>
        targets.any (fun tgt => tgt.entity == sk && permVal tgt.entity sid tgt.perm))
termination_by expr => sizeOf expr

/-- One Kleene / Knaster-Tarski fixed-point iteration step across all permissions. -/
def stepPermVal (m : AccessModel) (store : List Tuple) (now : Timestamp) (a : Actor)
    (prev : EntityName → ObjId → PermName → Bool) :
    EntityName → ObjId → PermName → Bool :=
  fun e id p =>
    match m.findPerm e p with
    | none => false
    | some defn => evalExprWith store now a prev e id defn.expr

/-- `k`-step fixed-point iteration starting from `⊥` (`fun _ _ _ => false`). -/
def iterPermVal (m : AccessModel) (store : List Tuple) (now : Timestamp) (a : Actor) :
    Nat → (EntityName → ObjId → PermName → Bool)
  | 0 => fun _ _ _ => false
  | k + 1 => stepPermVal m store now a (iterPermVal m store now a k)

/--
Forward point-check evaluation (`check`): iterates `iterPermVal` for `fuel`
rounds. For any finite store with `N` tuples and `P` permissions,
`fuel = (N + 1) * (P + 1)` saturates every monotonic recursive SCC.
-/
def evalPermFuel (m : AccessModel) (store : List Tuple) (now : Timestamp) (a : Actor)
    (fuel : Nat) (e : EntityName) (id : ObjId) (p : PermName) : Bool :=
  iterPermVal m store now a fuel e id p

/-- Default saturating fuel for a finite model and tuple store. -/
def defaultFuel (m : AccessModel) (store : List Tuple) : Nat :=
  (store.length + 1) * (m.permissions.length + 1)

/-- Canonical reference `check` decision. -/
def evalCheck (m : AccessModel) (store : List Tuple) (now : Timestamp) (a : Actor)
    (e : EntityName) (id : ObjId) (p : PermName) : Bool :=
  evalPermFuel m store now a (defaultFuel m store) e id p

/--
Reverse lookup / `compileFilter` semantics over the candidate resource universe:
returns every `id ∈ universe` for which `evalCheck` holds.
-/
def lookupResourcesOver (m : AccessModel) (store : List Tuple) (now : Timestamp)
    (a : Actor) (e : EntityName) (p : PermName) (candidates : List ObjId) : List ObjId :=
  candidates.filter (fun id => evalCheck m store now a e id p)

/--
Foreign-key consistency hypothesis for `scopeColumns`:
for a row `r`, its app-table column `fk r` holds the unique active `rel` parent
of entity `parentEntity` in `store`.
-/
def ScopeColumnConsistent (store : List Tuple) (now : Timestamp)
    (childEntity : EntityName) (rel : RelName) (parentEntity : EntityName)
    (fk : ObjId → ObjId) : Prop :=
  ∀ r, directEntityEdges store now childEntity r rel = [(parentEntity, fk r)]

/--
Scoped `compileFilter` evaluation for a single `through(rel, [parentEntity#parentPerm])`
branch rewritten onto `fk r ∈ allowedParents`.
-/
def evalScopedThrough (m : AccessModel) (store : List Tuple) (now : Timestamp)
    (a : Actor) (parentEntity : EntityName) (parentPerm : PermName)
    (parentUniverse : List ObjId) (fk : ObjId → ObjId) (r : ObjId) : Bool :=
  (lookupResourcesOver m store now a parentEntity parentPerm parentUniverse).contains (fk r)

/--
Branch-pruning `resolveFilter` semantics:
given include-branch predicates (each backed by a list of allowed IDs for a
column `col r`) and an exclude list `excludedIds`, prunes empty branches and
evaluates the pruned predicate.
-/
def evalBranchList (branches : List ((ObjId → ObjId) × List ObjId)) (r : ObjId) : Bool :=
  branches.any (fun (col, ids) => ids.contains (col r))

def pruneEmptyBranches (branches : List ((ObjId → ObjId) × List ObjId)) :
    List ((ObjId → ObjId) × List ObjId) :=
  branches.filter (fun (_, ids) => !ids.isEmpty)

def evalResolvedFilter (includeBranches : List ((ObjId → ObjId) × List ObjId))
    (excludedIds : List ObjId) (r : ObjId) : Bool :=
  let activeIncludes := pruneEmptyBranches includeBranches
  if activeIncludes.isEmpty then
    false
  else
    let inc := evalBranchList activeIncludes r
    if excludedIds.isEmpty then inc else inc && !(excludedIds.contains r)

/-- One `(namespace, tuple)` row in a multi-tenant relationship table. -/
structure NamespacedTuple where
  ns : String
  tuple : Tuple
  deriving DecidableEq, Repr, BEq

/-- Projection of a multi-tenant table to a single namespace (`WHERE namespace = $1`). -/
def storeForNamespace (ns : String) (table : List NamespacedTuple) : List Tuple :=
  (table.filter (fun row => row.ns == ns)).map (fun row => row.tuple)

/-- Specification for one foreign-key column in multi-column `scopeColumns`. -/
structure ScopeColumnSpec where
  rel : RelName
  parentEntity : EntityName
  parentPerm : PermName
  parentUniverse : List ObjId
  fk : ObjId → ObjId

/--
A single-target column-backed relation stored directly on an application table
`(id, Option targetId)` (`NULL` represents absence of a link).
-/
def materializeColumnTable (entity : EntityName) (rel : RelName)
    (targetEntity : EntityName) (rows : List (ObjId × Option ObjId)) : List Tuple :=
  rows.filterMap (fun (id, optTarget) =>
    match optTarget with
    | none => none
    | some targetId =>
        some {
          resourceKind := entity
          resourceId := id
          relation := rel
          subject := .direct targetEntity targetId
          expiresAt := none
        })

/-- Direct lookup of active edges from a column-backed table without duplicating into `store`. -/
def columnBackedEdges (targetEntity : EntityName)
    (rows : List (ObjId × Option ObjId)) (id : ObjId) : List (EntityName × ObjId) :=
  rows.filterMap (fun (rowId, optTarget) =>
    if rowId == id then
      match optTarget with
      | none => none
      | some targetId => some (targetEntity, targetId)
    else
      none)

end DadsAccess
