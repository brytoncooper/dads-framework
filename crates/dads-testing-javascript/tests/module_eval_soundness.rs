//! End-to-end soundness and precision proofs for top-level module-evaluation changes,
//! `/*#__PURE__*/`, unshadowed pure built-ins, and `workspace.pureFactories`.

use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request_with_graph,
};
use dads_testing_javascript::analyze_request;
use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    assert!(status.success(), "git {args:?} failed");
    Ok(())
}

fn commit_all(dir: &Path, message: &str) -> Result<(), Box<dyn Error>> {
    git(dir, &["add", "."])?;
    git(
        dir,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e.invalid",
            "commit",
            "-qm",
            message,
        ],
    )
}

fn request(dir: &Path) -> NativeRequest {
    NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        manifest_path: None,
        base: None,
        head: None,
        all: false,
        task_ids: Vec::new(),
        task_kinds: Vec::new(),
        shard: None,
        jobs: None,
        cache: false,
        remote_cache_url: None,
        ..NativeRequest::default()
    }
}

fn build_tax_workspace(name: &str, pure_factories: &[&str]) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!("dads-js-eval-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    for sub in ["billing", "ui"] {
        fs::create_dir_all(dir.join(sub))?;
    }
    git(&dir, &["init", "-q"])?;
    let factories_json = format!(
        "[{}]",
        pure_factories
            .iter()
            .map(|entry| format!("\"{entry}\""))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let manifest = format!(
        r#"{{
  "schemaVersion": 1,
  "workspace": {{
    "root": ".",
    "pureFactories": {factories_json},
    "fullFallback": {{ "taskIds": ["billing:test", "ui:test"] }}
  }},
  "projects": [
    {{ "id": "billing", "root": "billing", "fallbackDependencies": [] }},
    {{ "id": "ui", "root": "ui", "fallbackDependencies": ["billing"] }}
  ],
  "tasks": [
    {{
      "id": "billing:test",
      "project": "billing",
      "kind": "test",
      "execution": {{ "executable": "true", "fileNarrowing": {{ "suffixes": [".test.ts"] }} }},
      "dependsOn": [],
      "impact": {{ "mode": "reachability", "paths": [] }}
    }},
    {{
      "id": "ui:test",
      "project": "ui",
      "kind": "test",
      "execution": {{ "executable": "true", "fileNarrowing": {{ "suffixes": [".test.ts"] }} }},
      "dependsOn": [],
      "impact": {{ "mode": "reachability", "paths": [] }}
    }}
  ]
}}
"#
    );
    fs::write(dir.join("dads.testing.json"), manifest)?;
    write_tax_sources(&dir)?;
    commit_all(&dir, "baseline")?;
    Ok(dir)
}

fn write_tax_sources(dir: &Path) -> Result<(), Box<dyn Error>> {
    fs::write(
        dir.join("billing/shared.ts"),
        "export const shared: { factor: number; extra?: number } = { factor: 2, extra: 1 };\n",
    )?;
    fs::write(
        dir.join("billing/side-effect.ts"),
        "import { shared } from './shared';\nshared.factor = 9;\nexport const unused = 1;\n",
    )?;
    fs::write(
        dir.join("billing/zod.ts"),
        "export const z = {\n  string: () => ({ min: (_n: number) => ({ optional: () => ({}) }) }),\n  object: (shape: Record<string, unknown>) => ({ optional: () => shape }),\n};\nexport function pgTable(name: string, cols: Record<string, unknown>) { return { name, cols }; }\nexport const React = { memo: <T>(c: T) => c };\n",
    )?;
    fs::write(
        dir.join("billing/tax.ts"),
        concat!(
            "import { shared } from './shared';\n",
            "import { z, pgTable, React } from './zod';\n",
            "export type TaxRate = number;\n",
            "function setRate(n: number) { shared.factor = n; return n; }\n",
            "function helper(v: number) { return v; }\n",
            "export const assignMarker = 2;\n",
            "export const callMarker = setRate(2);\n",
            "export const schema = z.object({ id: z.string().min(1) }).optional();\n",
            "export const table = pgTable('taxes', { rate: 2 });\n",
            "export const MemoView = React.memo(() => 'tax');\n",
            "export class TaxPolicy {\n",
            "  static { shared.factor = 2; }\n",
            "}\n",
            "export function computeTax(amount: number) { return amount * shared.factor; }\n",
            "export function formatTax(amount: number) { return `$${amount}`; }\n",
            "export const pureAnnotated = /*#__PURE__*/ helper(1);\n",
            "export const atPureAnnotated = /*@__PURE__*/ helper(1);\n",
            "export const frozen = Object.freeze({ a: 1 });\n",
            "export const sym = Symbol('tax');\n",
            "export const pattern = new RegExp('^[0-9]+$', 'i');\n",
            "export const codes = new Set(['USD', 'EUR']);\n",
            "export const rates = new Map([['USD', 1]]);\n",
        ),
    )?;
    fs::write(
        dir.join("billing/barrel.ts"),
        "export { computeTax, formatTax, type TaxRate } from './tax';\n",
    )?;
    fs::write(
        dir.join("ui/tax.test.ts"),
        "import { computeTax } from '../billing/barrel';\nexport const run = () => computeTax(10);\n",
    )?;
    fs::write(
        dir.join("ui/type-only.test.ts"),
        "import type { TaxRate } from '../billing/barrel';\nexport const check = (r: TaxRate) => r;\n",
    )?;
    fs::write(
        dir.join("ui/unrelated.test.ts"),
        "export const unrelated = () => 1 + 1;\n",
    )?;
    Ok(())
}

struct UiPlanOutcome {
    eval_changed: bool,
    decision: String,
    widened: bool,
    selected_files: Vec<String>,
}

fn plan_ui_test(dir: &Path) -> Result<UiPlanOutcome, Box<dyn Error>> {
    let req = request(dir);
    let graph = analyze_request(&req).ok_or("missing graph")?;
    let eval_changed = graph.module_eval_changed("billing/tax.ts");
    let response = execute_request_with_graph(req, Some(graph));
    assert!(response.ok, "{response:?}");
    let plan = response.result.ok_or("missing plan")?.plan;
    let ui = plan
        .tasks
        .into_iter()
        .find(|t| t.id == "ui:test")
        .ok_or("missing ui:test")?;
    Ok(UiPlanOutcome {
        eval_changed,
        decision: ui.decision,
        widened: ui.widened,
        selected_files: ui.selected_files,
    })
}

#[test]
fn catches_all_load_time_side_effect_edits_with_narrow_runtime_propagation()
-> Result<(), Box<dyn Error>> {
    let dir = build_tax_workspace("side-effects", &[])?;
    let baseline = fs::read_to_string(dir.join("billing/tax.ts"))?;

    let mutations = [
        (
            "export-initializer-assignment",
            baseline.replace(
                "export const assignMarker = 2;",
                "export const assignMarker = (shared.factor = 5);",
            ),
        ),
        (
            "export-initializer-call",
            baseline.replace(
                "export const callMarker = setRate(2);",
                "export const callMarker = setRate(5);",
            ),
        ),
        (
            "private-helper-called-by-export-initializer",
            baseline.replace(
                "function setRate(n: number) { shared.factor = n; return n; }",
                "function setRate(n: number) { shared.factor = n + 3; return n; }",
            ),
        ),
        (
            "class-static-block-side-effect",
            baseline.replace(
                "static { shared.factor = 2; }",
                "static { shared.factor = 7; }",
            ),
        ),
        (
            "private-top-level-assignment",
            format!("{baseline}shared.factor = 5;\n"),
        ),
        (
            "mixed-export-and-unused-runtime-import",
            format!(
                "import {{ unused }} from './side-effect';\n{}",
                baseline.replace("return `$${amount}`;", "return `USD ${amount}`;")
            ),
        ),
        (
            "unary-delete-is-impure",
            baseline.replace(
                "export const assignMarker = 2;",
                "export const assignMarker = delete shared.extra;",
            ),
        ),
    ];

    for (label, mutated) in mutations {
        fs::write(dir.join("billing/tax.ts"), mutated)?;
        let ui = plan_ui_test(&dir)?;
        assert!(
            ui.eval_changed,
            "{label}: expected module_eval_changed = true"
        );
        assert_eq!(ui.decision, "run", "{label}: expected ui:test to run");
        assert!(
            !ui.widened,
            "{label}: expected narrow runtime-edge propagation without project widening"
        );
        assert_eq!(
            ui.selected_files,
            vec!["ui/tax.test.ts".to_owned()],
            "{label}: expected ONLY ui/tax.test.ts (skipping unrelated & import-type tests)"
        );
    }

    // Deleting an effectful top-level statement also triggers module_eval_changed via baseline AST.
    fs::write(
        dir.join("billing/tax.ts"),
        format!("{baseline}shared.factor = 5;\n"),
    )?;
    commit_all(&dir, "add top-level assignment")?;
    fs::write(dir.join("billing/tax.ts"), &baseline)?;
    let ui = plan_ui_test(&dir)?;
    assert!(
        ui.eval_changed,
        "deleting impure statement must set module_eval_changed"
    );
    assert_eq!(ui.decision, "run");
    assert!(!ui.widened);
    assert_eq!(ui.selected_files, vec!["ui/tax.test.ts".to_owned()]);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn narrows_pure_edits_annotations_builtins_and_configured_pure_factories()
-> Result<(), Box<dyn Error>> {
    let dir = build_tax_workspace("pure-narrowing", &["z.*", "pgTable", "React.memo"])?;
    let baseline = fs::read_to_string(dir.join("billing/tax.ts"))?;

    let pure_mutations = [
        (
            "pure-private-with-export",
            format!(
                "{}const unused = 'b';\n",
                baseline.replace(
                    "export const assignMarker = 2;",
                    "export const assignMarker = 5;"
                )
            ),
        ),
        (
            "pure-export-alongside-untouched-impure-const",
            baseline.replace("return `$${amount}`;", "return `EUR ${amount}`;"),
        ),
        (
            "pure-comment-annotations",
            baseline
                .replace(
                    "export const pureAnnotated = /*#__PURE__*/ helper(1);",
                    "export const pureAnnotated = /*#__PURE__*/ helper(2);",
                )
                .replace(
                    "export const atPureAnnotated = /*@__PURE__*/ helper(1);",
                    "export const atPureAnnotated = /*@__PURE__*/ helper(2);",
                ),
        ),
        (
            "pure-builtins",
            baseline
                .replace("Object.freeze({ a: 1 })", "Object.freeze({ a: 2 })")
                .replace("Symbol('tax')", "Symbol('tax-v2')")
                .replace("new RegExp('^[0-9]+$', 'i')", "new RegExp('^[0-9]+$')")
                .replace("new Set(['USD', 'EUR'])", "new Set(['USD', 'GBP'])")
                .replace("new Map([['USD', 1]])", "new Map([['USD', 2]])"),
        ),
        (
            "configured-pure-factories-including-fluent-chain",
            baseline
                .replace(
                    "z.object({ id: z.string().min(1) }).optional()",
                    "z.object({ id: z.string().min(2) }).optional()",
                )
                .replace(
                    "pgTable('taxes', { rate: 2 })",
                    "pgTable('taxes', { rate: 3 })",
                )
                .replace("React.memo(() => 'tax')", "React.memo(() => 'tax-v2')"),
        ),
    ];

    for (label, mutated) in pure_mutations {
        fs::write(dir.join("billing/tax.ts"), mutated)?;
        let ui = plan_ui_test(&dir)?;
        assert!(
            !ui.eval_changed,
            "{label}: expected module_eval_changed = false"
        );
        assert_eq!(
            ui.decision, "skip-proven-unaffected",
            "{label}: expected ui:test to be skipped"
        );
        assert!(!ui.widened, "{label}: must not widen");
    }

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn rejects_impure_pure_factory_args_and_shadowed_builtins() -> Result<(), Box<dyn Error>> {
    let dir = build_tax_workspace("pure-guards", &["z.*", "pgTable", "React.memo"])?;
    let baseline = fs::read_to_string(dir.join("billing/tax.ts"))?;

    // Pure factory with an impure argument MUST still trigger module_eval_changed!
    fs::write(
        dir.join("billing/tax.ts"),
        baseline.replace(
            "z.object({ id: z.string().min(1) }).optional()",
            "z.object({ id: setRate(5) }).optional()",
        ),
    )?;
    let ui = plan_ui_test(&dir)?;
    assert!(
        ui.eval_changed,
        "impure arg inside pureFactory must set module_eval_changed"
    );
    assert_eq!(ui.decision, "run");
    assert_eq!(ui.selected_files, vec!["ui/tax.test.ts".to_owned()]);

    // Locally shadowed built-in (`const Object = ...`) MUST NOT be trusted as pure!
    fs::write(
        dir.join("billing/tax.ts"),
        format!(
            "const Object = {{ freeze: <T>(x: T) => {{ shared.factor = 9; return x; }} }};\n{}",
            baseline.replace("Object.freeze({ a: 1 })", "Object.freeze({ a: 3 })")
        ),
    )?;
    let ui = plan_ui_test(&dir)?;
    assert!(
        ui.eval_changed,
        "shadowed Object.freeze must set module_eval_changed"
    );
    assert_eq!(ui.decision, "run");
    assert_eq!(ui.selected_files, vec!["ui/tax.test.ts".to_owned()]);

    // Verify changed_exports stays exact on pure edit.
    fs::write(
        dir.join("billing/tax.ts"),
        baseline.replace("return `$${amount}`;", "return `CAD ${amount}`;"),
    )?;
    let graph = analyze_request(&request(&dir)).ok_or("missing graph")?;
    assert_eq!(
        graph.changed_exports("billing/tax.ts"),
        Some(BTreeSet::from(["formatTax".to_owned()]))
    );

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
