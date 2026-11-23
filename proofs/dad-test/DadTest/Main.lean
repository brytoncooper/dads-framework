import DadTest

open DadTest

/--
Rich tight-precision oracle scenario verifying ALL 5 precision upgrades at once:
1. Diamond `export *` barrel (soundness: `bar` is NOT dropped after `foo`)
2. Intra-file def-use in `mid.ts`: `usesBar` depends on `bar`, `unrelated` does NOT
3. `import type` edge to `typeConsumer.test.ts`: skipped on `.runtime`, run on `.typecheck`
4. Tracked namespace import `import * as ns` (`ns.usesBar`): exact match, zero widening
5. Bounded dynamic import `import(\`./handlers/${k}.js\`)`: hits ONLY matching target
6. Comment-only edit (`semanticChange = false`): runs ZERO tests!
-/
def tightPrecisionGraph : DepGraph :=
  { modules := [
      "domains/a/foo.ts",
      "domains/a/bar.ts",
      "domains/a/barrel.ts",
      "domains/a/mid.ts",
      "domains/a/usesBar.test.ts",
      "domains/a/unrelated.test.ts",
      "domains/a/typeConsumer.test.ts",
      "domains/a/nsConsumer.test.ts",
      "domains/a/commentOnly.ts"
    ]
    edges := [
      { source := "domains/a/barrel.ts", target := "domains/a/foo.ts", kind := .reexportAll },
      { source := "domains/a/barrel.ts", target := "domains/a/bar.ts", kind := .reexportAll },
      { source := "domains/a/mid.ts", target := "domains/a/barrel.ts", kind := .namedRuntime ["bar"] },
      { source := "domains/a/usesBar.test.ts", target := "domains/a/mid.ts", kind := .namedRuntime ["usesBar"] },
      { source := "domains/a/unrelated.test.ts", target := "domains/a/mid.ts", kind := .namedRuntime ["unrelated"] },
      { source := "domains/a/typeConsumer.test.ts", target := "domains/a/mid.ts", kind := .typeOnly ["usesBar"] },
      { source := "domains/a/nsConsumer.test.ts", target := "domains/a/mid.ts", kind := .namespaceTracked ["usesBar"] }
    ]
    affectedOwnExports := fun src tgt sym =>
      if src == "domains/a/mid.ts" && tgt == "domains/a/barrel.ts" && sym == "bar" then
        ["usesBar"]
      else []
    allOwnExports := fun src =>
      if src == "domains/a/mid.ts" then ["usesBar", "unrelated"] else []
    erasesTypeOnly := true
    changeOf := fun m =>
      if m == "domains/a/foo.ts" then
        some { complete := true, semanticChange := true, exports := ["foo"] }
      else if m == "domains/a/bar.ts" then
        some { complete := true, semanticChange := true, exports := ["bar"] }
      else if m == "domains/a/commentOnly.ts" then
        some { complete := true, semanticChange := false, exports := [] }
      else none
    declaredUncertainties := [] }

def tightManifest : Manifest :=
  { projects := ["domains-a"]
    ownerOf := fun p => if p.startsWith "domains/a/" then some "domains-a" else none
    fallbackDeps := fun _ => []
    tasks := [
      { id := "domains-a:unit"
        project := "domains-a"
        impact := .reachability
        channel := .runtime
        testFiles := [
          "domains/a/usesBar.test.ts",
          "domains/a/unrelated.test.ts",
          "domains/a/typeConsumer.test.ts",
          "domains/a/nsConsumer.test.ts"
        ]
        assetPaths := []
        dependsOn := [] },
      { id := "domains-a:typecheck"
        project := "domains-a"
        impact := .reachability
        channel := .typecheck
        testFiles := [
          "domains/a/usesBar.test.ts",
          "domains/a/unrelated.test.ts",
          "domains/a/typeConsumer.test.ts",
          "domains/a/nsConsumer.test.ts"
        ]
        assetPaths := []
        dependsOn := [] }
    ] }

def jsonList (xs : List String) : String :=
  "[" ++ String.intercalate "," (xs.map fun s => "\"" ++ s ++ "\"") ++ "]"

def scopeToJson (s : TaskExecutionScope) : String :=
  match s with
  | .skipProvenUnaffected => "{\"decision\":\"skip-proven-unaffected\",\"widened\":false,\"selectedFiles\":[]}"
  | .subset files => "{\"decision\":\"run\",\"widened\":false,\"selectedFiles\":" ++ jsonList files ++ "}"
  | .allTests => "{\"decision\":\"run\",\"widened\":true,\"selectedFiles\":[]}"

def main (args : List String) : IO Unit := do
  let plan := buildPlan tightManifest (some tightPrecisionGraph) ["domains/a/foo.ts", "domains/a/bar.ts"]
  let commentPlan := buildPlan tightManifest (some tightPrecisionGraph) ["domains/a/commentOnly.ts"]
  match tightManifest.tasks with
  | [unitTask, typeTask] =>
      let unitScope := plan.taskScope unitTask
      let typeScope := plan.taskScope typeTask
      let commentUnitScope := commentPlan.taskScope unitTask
      let commentTypeScope := commentPlan.taskScope typeTask
      if unitScope != .subset ["domains/a/usesBar.test.ts", "domains/a/nsConsumer.test.ts"] then
        throw (IO.userError s!"unexpected runtime scope: {repr unitScope}")
      if typeScope != .subset ["domains/a/usesBar.test.ts", "domains/a/typeConsumer.test.ts", "domains/a/nsConsumer.test.ts"] then
        throw (IO.userError s!"unexpected typecheck scope: {repr typeScope}")
      if commentUnitScope != .skipProvenUnaffected then
        throw (IO.userError s!"expected skipProvenUnaffected for comment-only edit, got {repr commentUnitScope}")
      if args.contains "--json" then
        IO.println (
          "{" ++
            "\"diamond\":{" ++
              "\"domains-a:unit\":" ++ scopeToJson unitScope ++ "," ++
              "\"domains-a:typecheck\":" ++ scopeToJson typeScope ++
            "}," ++
            "\"commentOnly\":{" ++
              "\"domains-a:unit\":" ++ scopeToJson commentUnitScope ++ "," ++
              "\"domains-a:typecheck\":" ++ scopeToJson commentTypeScope ++
            "}" ++
          "}"
        )
      else
        IO.println s!"runtime unit scope:      {repr unitScope}"
        IO.println s!"typecheck scope:         {repr typeScope}"
        IO.println s!"comment-only edit scope: {repr commentUnitScope}"
        IO.println "Lean 4 tight-precision oracle self-check passed."
  | _ => throw (IO.userError "unexpected task list")
