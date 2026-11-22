/-!
# Dads Access IR Model (`DadsAccess.Model`)

Formal AST mirroring `@dads-framework/access` IR (`AccessModel`), relationship
tuples (`dad_authorization_relationship`), and schema validation invariants.
-/

namespace DadsAccess

abbrev EntityName := String
abbrev RelName := String
abbrev PermName := String
abbrev ObjId := String
abbrev Timestamp := Nat

/-- Concrete actor (`user:alice`). -/
structure Actor where
  kind : EntityName
  id : ObjId
  deriving DecidableEq, Repr, BEq

/-- Subject stored in a relationship tuple. -/
inductive Subject where
  | direct (kind : EntityName) (id : ObjId)
  | wildcard (kind : EntityName)
  | subjectSet (kind : EntityName) (id : ObjId) (rel : RelName)
  deriving DecidableEq, Repr, BEq

/-- One row in `dad_authorization_relationship`. -/
structure Tuple where
  resourceKind : EntityName
  resourceId : ObjId
  relation : RelName
  subject : Subject
  expiresAt : Option Timestamp := none
  deriving DecidableEq, Repr, BEq

/-- Declared target shape on a relation (mirrors `CompiledAuthorizationRelationTarget`). -/
inductive RelTarget where
  | entity (kind : EntityName)
  | wildcard (kind : EntityName)
  | subjectSet (kind : EntityName) (rel : RelName)
  deriving DecidableEq, Repr, BEq

/-- Declared relation on an entity. -/
structure RelationDef where
  entity : EntityName
  name : RelName
  targets : List RelTarget
  deriving DecidableEq, Repr, BEq

/-- Arrow target resolved at compile time (`entity#perm`). -/
structure ArrowTarget where
  entity : EntityName
  perm : PermName
  deriving DecidableEq, Repr, BEq

/-- Permission expression AST (mirrors `CompiledPermissionExpression`). -/
inductive Expr where
  | rel (relation : RelName)
  | anyOf (children : List Expr)
  | allOf (children : List Expr)
  | exclude (includeExpr : Expr) (excludeExpr : Expr)
  | through (relation : RelName) (targets : List ArrowTarget)
  | throughAll (relation : RelName) (targets : List ArrowTarget)
  deriving Repr, BEq

/-- Declared permission on an entity. -/
structure PermissionDef where
  entity : EntityName
  name : PermName
  expr : Expr
  deriving Repr, BEq

/-- Compiled authorization schema (`AccessModel`). -/
structure AccessModel where
  relations : List RelationDef
  permissions : List PermissionDef
  deriving Repr, BEq

/-- Look up a declared permission by `(entity, perm)`. -/
def AccessModel.findPerm (m : AccessModel) (e : EntityName) (p : PermName) :
    Option PermissionDef :=
  m.permissions.find? (fun d => d.entity == e && d.name == p)

/-- Look up a declared relation by `(entity, rel)`. -/
def AccessModel.findRel (m : AccessModel) (e : EntityName) (r : RelName) :
    Option RelationDef :=
  m.relations.find? (fun d => d.entity == e && d.name == r)

/-- A concrete subject matches a declared relation target. -/
def Subject.matchesTarget (s : Subject) (t : RelTarget) : Bool :=
  match s, t with
  | .direct k _, .entity tk => k == tk
  | .wildcard k, .wildcard tk => k == tk
  | .subjectSet k _ r, .subjectSet tk tr => k == tk && r == tr
  | _, _ => false

/-- Schema-validated tuple (enforced by `PostgresTuples.#validateWrite` / `SqliteTuples`). -/
def TupleValid (m : AccessModel) (tup : Tuple) : Prop :=
  ∃ rd, m.findRel tup.resourceKind tup.relation = some rd ∧
    ∃ tgt ∈ rd.targets, tup.subject.matchesTarget tgt = true

/-- Every tuple in the store respects the schema's declared relation targets. -/
def StoreValid (m : AccessModel) (store : List Tuple) : Prop :=
  ∀ tup ∈ store, TupleValid m tup

/-- True when relation `(e, r)` declares NO `subjectSet` targets. -/
def RelationNoUserset (m : AccessModel) (e : EntityName) (r : RelName) : Prop :=
  ∀ rd, m.findRel e r = some rd →
    ∀ tgt ∈ rd.targets, ∀ k rel, tgt ≠ RelTarget.subjectSet k rel

/-- Syntactic monotonicity: no negation (`exclude`) inside the expression. -/
def Expr.isMonotonic : Expr → Bool
  | .rel _ => true
  | .anyOf cs => cs.all Expr.isMonotonic
  | .allOf cs => cs.all Expr.isMonotonic
  | .exclude _ _ => false
  | .through _ _ => true
  | .throughAll _ _ => true
termination_by e => sizeOf e

end DadsAccess
