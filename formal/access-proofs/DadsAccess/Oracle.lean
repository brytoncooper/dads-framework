import Std.Data.HashMap
import Lean.Data.Json
import DadsAccess.Model
import DadsAccess.Semantics

/-!
# Dads Access Verified Oracle CLI (`dads-access-oracle`)

Native executable compiled from the formally verified Lean 4 reference
semantics (`DadsAccess.Semantics`). Reads a JSON payload on stdin and emits
`{ "checks": [...], "lookups": [...] }` on stdout for differential testing
against real PostgreSQL and SQLite adapters.
-/

open Lean (Json ToJson FromJson toJson fromJson?)
open DadsAccess

private def parseRelTarget (j : Json) : Except String RelTarget := do
  let kind ← j.getObjValAs? String "kind"
  match kind with
  | "entity" => return .entity (← j.getObjValAs? String "entity")
  | "wildcard" => return .wildcard (← j.getObjValAs? String "entity")
  | "subject-set" =>
      return .subjectSet (← j.getObjValAs? String "entity") (← j.getObjValAs? String "relation")
  | other => throw s!"Unknown relation target kind: {other}"

private def parseArrowTarget (j : Json) : Except String ArrowTarget := do
  return {
    entity := ← j.getObjValAs? String "entity"
    perm := ← j.getObjValAs? String "permission"
  }

private partial def parseExpr (j : Json) : Except String Expr := do
  let kind ← j.getObjValAs? String "kind"
  match kind with
  | "relation" => return .rel (← j.getObjValAs? String "relation")
  | "any-of" =>
      let arr ← j.getObjValAs? (Array Json) "expressions"
      let cs ← arr.toList.mapM parseExpr
      return .anyOf cs
  | "all-of" =>
      let arr ← j.getObjValAs? (Array Json) "expressions"
      let cs ← arr.toList.mapM parseExpr
      return .allOf cs
  | "exclude" =>
      let inc ← parseExpr (← j.getObjVal? "include")
      let exc ← parseExpr (← j.getObjVal? "exclude")
      return .exclude inc exc
  | "through" =>
      let rel ← j.getObjValAs? String "relation"
      let arr ← j.getObjValAs? (Array Json) "targets"
      let tgts ← arr.toList.mapM parseArrowTarget
      return .through rel tgts
  | "through-all" =>
      let rel ← j.getObjValAs? String "relation"
      let arr ← j.getObjValAs? (Array Json) "targets"
      let tgts ← arr.toList.mapM parseArrowTarget
      return .throughAll rel tgts
  | other => throw s!"Unknown expression kind: {other}"

private def parseModel (j : Json) : Except String AccessModel := do
  let relArr ← j.getObjValAs? (Array Json) "relations"
  let rels ← relArr.toList.mapM fun rj => do
    let tArr ← rj.getObjValAs? (Array Json) "targets"
    let tgts ← tArr.toList.mapM parseRelTarget
    return {
      entity := ← rj.getObjValAs? String "entity"
      name := ← rj.getObjValAs? String "wireName"
      targets := tgts
    }
  let permArr ← j.getObjValAs? (Array Json) "permissions"
  let perms ← permArr.toList.mapM fun pj => do
    return {
      entity := ← pj.getObjValAs? String "entity"
      name := ← pj.getObjValAs? String "wireName"
      expr := ← parseExpr (← pj.getObjVal? "expression")
    }
  return { relations := rels, permissions := perms }

private def parseTuple (j : Json) : Except String Tuple := do
  let rk ← j.getObjValAs? String "resourceKind"
  let rid ← j.getObjValAs? String "resourceId"
  let rel ← j.getObjValAs? String "relation"
  let sk ← j.getObjValAs? String "subjectKind"
  let sid ← j.getObjValAs? String "subjectId"
  let srel := (j.getObjValAs? String "subjectRelation").toOption.getD ""
  let isWild := (j.getObjValAs? Bool "subjectIsWildcard").toOption.getD false
  let exp : Option Nat :=
    match j.getObjVal? "expiresAt" with
    | .ok Json.null => none
    | .ok v => (fromJson? (α := Nat) v).toOption
    | .error _ => none
  let subj : Subject :=
    if isWild then .wildcard sk
    else if !srel.isEmpty then .subjectSet sk sid srel
    else .direct sk sid
  return {
    resourceKind := rk
    resourceId := rid
    relation := rel
    subject := subj
    expiresAt := exp
  }

/--
Tabulates `iterPermVal` over all `(entity, objId, perm)` pairs present in the
finite store so the verified `evalExprWith` step runs in polynomial time per
actor instead of recomputing unmemoized recursive closures.
-/
private def allEntityIds (store : List Tuple) (extra : List (EntityName × ObjId)) :
    List (EntityName × ObjId) :=
  let fromTuples := store.flatMap fun t =>
    let res := (t.resourceKind, t.resourceId)
    match t.subject with
    | .direct sk sid => [res, (sk, sid)]
    | .subjectSet sk sid _ => [res, (sk, sid)]
    | .wildcard _ => [res]
  (fromTuples ++ extra).eraseDups

private def tabulateCheck (m : AccessModel) (store : List Tuple) (now : Timestamp)
    (a : Actor) (extra : List (EntityName × ObjId)) :
    Std.HashMap (EntityName × ObjId × PermName) Bool :=
  let nodes := allEntityIds store extra
  let keys : List (EntityName × ObjId × PermName) :=
    m.permissions.flatMap fun d =>
      nodes.filterMap fun (e, oid) =>
        if e == d.entity then some (e, oid, d.name) else none
  let maxSteps := keys.length + 1
  let rec loop (steps : Nat) (cur : Std.HashMap (EntityName × ObjId × PermName) Bool) :
      Std.HashMap (EntityName × ObjId × PermName) Bool :=
    match steps with
    | 0 => cur
    | k + 1 =>
        let lookup : EntityName → ObjId → PermName → Bool :=
          fun e oid p => cur.getD (e, oid, p) false
        let (next, changed) :=
          keys.foldl
            (fun (acc, diff) (e, oid, p) =>
              let v := stepPermVal m store now a lookup e oid p
              let prev := cur.getD (e, oid, p) false
              (acc.insert (e, oid, p) v, diff || (v != prev)))
            (Std.HashMap.emptyWithCapacity keys.length, false)
        if !changed then next else loop k next
  loop maxSteps (Std.HashMap.emptyWithCapacity keys.length)

private def runOracle (input : String) : Except String Json := do
  let j ← Json.parse input
  let model ← parseModel (← j.getObjVal? "model")
  let tArr ← j.getObjValAs? (Array Json) "tuples"
  let tuples ← tArr.toList.mapM parseTuple
  let now ← j.getObjValAs? Nat "now"
  let checkArr ← j.getObjValAs? (Array Json) "checks"
  let lookupArr ← j.getObjValAs? (Array Json) "lookups"

  let parsedChecks : Array (Actor × EntityName × ObjId × PermName) ← checkArr.mapM fun cj => do
    return (
      ({ kind := ← cj.getObjValAs? String "subjectKind",
         id := ← cj.getObjValAs? String "subjectId" } : Actor),
      ← cj.getObjValAs? String "resourceKind",
      ← cj.getObjValAs? String "resourceId",
      ← cj.getObjValAs? String "permission"
    )
  let parsedLookups : Array (Actor × EntityName × PermName × List ObjId) ← lookupArr.mapM fun lj => do
    return (
      ({ kind := ← lj.getObjValAs? String "subjectKind",
         id := ← lj.getObjValAs? String "subjectId" } : Actor),
      ← lj.getObjValAs? String "resourceKind",
      ← lj.getObjValAs? String "permission",
      (← lj.getObjValAs? (Array String) "universe").toList
    )

  let checkList := parsedChecks.toList
  let lookupList := parsedLookups.toList
  let extraNodes : List (EntityName × ObjId) :=
    checkList.map (fun item => (item.2.1, item.2.2.1)) ++
    lookupList.flatMap (fun item => item.2.2.2.map (fun rid => (item.2.1, rid)))
  let actors : List Actor :=
    (checkList.map (fun item => item.1) ++
     lookupList.map (fun item => item.1)).eraseDups

  let tables : List (Actor × Std.HashMap (EntityName × ObjId × PermName) Bool) :=
    actors.map (fun a => (a, tabulateCheck model tuples now a extraNodes))
  let evalMemo (a : Actor) (rk : EntityName) (rid : ObjId) (p : PermName) : Bool :=
    match tables.find? (fun entry => entry.1 == a) with
    | none => false
    | some entry => entry.2.getD (rk, rid, p) false

  let checkResults := parsedChecks.map fun item =>
    toJson (evalMemo item.1 item.2.1 item.2.2.1 item.2.2.2)
  let lookupResults := parsedLookups.map fun item =>
    toJson (item.2.2.2.filter (fun rid => evalMemo item.1 item.2.1 rid item.2.2.1))
  return Json.mkObj [
    ("checks", Json.arr checkResults),
    ("lookups", Json.arr lookupResults)
  ]

def main : IO Unit := do
  let stdin ← IO.getStdin
  let input ← stdin.readToEnd
  match runOracle input with
  | .ok out => IO.println out.compress
  | .error msg =>
      IO.eprintln s!"dads-access-oracle error: {msg}"
      IO.Process.exit 1
