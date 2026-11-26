//! Integration tests for:
//! 1. Unified project dependency graph (`Oxc imports U fallbackDependencies`) widening uncertainties
//!    and `diagnose` closures even when `fallbackDependencies` is empty.
//! 2. Planner-computed `TaskCacheInputs` (forward Oxc closure, scoped dynamic imports, fail-closed
//!    conditions, and outside-root extra files).

use dads_testing_core::graph::{
    ChangedModuleEvidence, DependencyGraph, GraphUncertainty, GraphUncertaintyScope, ImportFact,
    ImportKind, ModuleNode, SourceSpan, SymbolFact,
};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, PlanResult, TaskCause, TaskDecision,
    execute_request_with_graph,
};
use serde_json::json;
use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempRepo(PathBuf);

impl TempRepo {
    fn create(
        label: &str,
        manifest: &serde_json::Value,
        files: &[(&str, &str)],
    ) -> Result<Self, Box<dyn Error>> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "dads-unified-{label}-{}-{nonce}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&dir)?;
        for (rel, content) in files {
            let full = dir.join(rel);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(full, content)?;
        }
        fs::write(
            dir.join("dads.testing.json"),
            serde_json::to_string_pretty(manifest)?,
        )?;
        run_git(&dir, &["init", "-q"])?;
        run_git(&dir, &["add", "."])?;
        run_git(
            &dir,
            &[
                "-c",
                "user.name=Dads",
                "-c",
                "user.email=dads@example.invalid",
                "commit",
                "-qm",
                "init",
            ],
        )?;
        Ok(Self(dir))
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run_git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    if !status.success() {
        return Err(format!("git {args:?} failed").into());
    }
    Ok(())
}

fn mod_node(path: &str, exports: &[&str], imports: &[&str]) -> ModuleNode {
    ModuleNode {
        path: path.to_owned(),
        language: "typescript".to_owned(),
        declarations: exports
            .iter()
            .map(|name| SymbolFact {
                name: (*name).to_owned(),
                span: SourceSpan { start: 0, end: 1 },
            })
            .collect(),
        references: Vec::new(),
        imports: imports
            .iter()
            .map(|target| ImportFact {
                specifier: (*target).to_owned(),
                span: SourceSpan { start: 0, end: 1 },
                kind: ImportKind::Static,
                type_only: false,
                requested_symbols: BTreeSet::new(),
                namespace_import: true,
                reexport_all: false,
                reexport_namespace: None,
                resolved_path: Some((*target).to_owned()),
                position: None,
                export_deps: None,
                member_reads: None,
            })
            .collect(),
    }
}

fn plan_with_graph(
    root: &Path,
    graph: Option<DependencyGraph>,
) -> Result<PlanResult, Box<dyn Error>> {
    let resp = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Plan,
            workspace_root: root.to_string_lossy().into_owned(),
            ..NativeRequest::default()
        },
        graph,
    );
    if !resp.ok {
        return Err(format!("plan failed: {resp:?}").into());
    }
    Ok(resp.result.ok_or("missing result")?.plan)
}

fn task<'a>(plan: &'a PlanResult, id: &str) -> Result<&'a TaskDecision, Box<dyn Error>> {
    plan.tasks
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("missing task {id}").into())
}

fn empty_fallback_fixture(label: &str) -> Result<(TempRepo, Vec<ModuleNode>), Box<dyn Error>> {
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["billing:test", "ui:test", "web:test", "unrelated:test"] }
        },
        "projects": [
            { "id": "billing", "root": "libs/billing", "fallbackDependencies": [] },
            { "id": "ui", "root": "libs/ui", "fallbackDependencies": [] },
            { "id": "web", "root": "apps/web", "fallbackDependencies": [] },
            { "id": "unrelated", "root": "libs/unrelated", "fallbackDependencies": [] }
        ],
        "tasks": [
            { "id": "billing:test", "project": "billing", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
            { "id": "ui:test", "project": "ui", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
            { "id": "web:test", "project": "web", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
            { "id": "unrelated:test", "project": "unrelated", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
        ]
    });
    let repo = TempRepo::create(
        label,
        &manifest,
        &[
            ("libs/billing/src/calc.ts", "export const calc = 1;\n"),
            ("libs/billing/src/rates.json", "{\"rate\":1}\n"),
            ("libs/ui/src/widget.ts", "export const widget = 1;\n"),
            ("apps/web/src/page.ts", "export const page = 1;\n"),
            ("libs/unrelated/src/other.ts", "export const other = 1;\n"),
        ],
    )?;
    let nodes = vec![
        mod_node("libs/billing/src/calc.ts", &["calc"], &[]),
        mod_node(
            "libs/ui/src/widget.ts",
            &["widget"],
            &["libs/billing/src/calc.ts"],
        ),
        mod_node(
            "apps/web/src/page.ts",
            &["page"],
            &["libs/ui/src/widget.ts"],
        ),
        mod_node("libs/unrelated/src/other.ts", &["other"], &[]),
    ];
    Ok((repo, nodes))
}

#[test]
fn empty_fallback_deps_widen_unattributed_and_uncovered_changes_across_oxc_edges()
-> Result<(), Box<dyn Error>> {
    let (repo, base_nodes) = empty_fallback_fixture("empty-fallback-plan")?;

    // Case 1: unattributed-module-change in billing widens to ui AND web via Oxc edges.
    fs::write(
        repo.0.join("libs/billing/src/calc.ts"),
        "export const calc = 2;\n",
    )?;
    let unattr_graph = DependencyGraph::new(base_nodes.clone(), Vec::new())
        .with_changed_module_evidence(vec![ChangedModuleEvidence {
            path: "libs/billing/src/calc.ts".into(),
            changed_exports: BTreeSet::new(),
            every_hunk_is_attributed: false,
            semantic_change: true,
            type_only_change: false,
            module_eval_changed: false,
            changed_type_exports: None,
        }]);
    let plan1 = plan_with_graph(&repo.0, Some(unattr_graph))?;
    assert_eq!(task(&plan1, "billing:test")?.decision, "run");
    assert_eq!(task(&plan1, "ui:test")?.decision, "run");
    assert!(task(&plan1, "ui:test")?.widened);
    assert_eq!(task(&plan1, "web:test")?.decision, "run");
    assert!(task(&plan1, "web:test")?.widened);
    assert!(
        task(&plan1, "web:test")?
            .causes
            .contains(&TaskCause::FallbackDependency {
                project: "billing".into(),
            })
    );
    assert_eq!(
        task(&plan1, "unrelated:test")?.decision,
        "skip-proven-unaffected"
    );

    // Case 2: changed-module-unavailable (non-TS asset in billing) widens to ui AND web.
    fs::write(
        repo.0.join("libs/billing/src/calc.ts"),
        "export const calc = 1;\n",
    )?;
    fs::write(repo.0.join("libs/billing/src/rates.json"), "{\"rate\":2}\n")?;
    let plan2 = plan_with_graph(&repo.0, Some(DependencyGraph::new(base_nodes, Vec::new())))?;
    assert!(plan2.issues.iter().any(|i| {
        i.code == "changed-module-unavailable"
            && i.path.as_deref() == Some("libs/billing/src/rates.json")
    }));
    assert_eq!(task(&plan2, "billing:test")?.decision, "run");
    assert_eq!(task(&plan2, "ui:test")?.decision, "run");
    assert_eq!(task(&plan2, "web:test")?.decision, "run");
    assert_eq!(
        task(&plan2, "unrelated:test")?.decision,
        "skip-proven-unaffected"
    );
    Ok(())
}

#[test]
fn diagnose_computes_unified_widening_closures_across_oxc_edges_with_empty_fallbacks()
-> Result<(), Box<dyn Error>> {
    let (repo, base_nodes) = empty_fallback_fixture("empty-fallback-diagnose")?;
    let diag_graph = DependencyGraph::new(
        base_nodes,
        vec![GraphUncertainty {
            path: "libs/billing/src/calc.ts".into(),
            code: "unresolved-local-module".into(),
            message: "Cannot resolve local module.".into(),
            scope: GraphUncertaintyScope::ReachedModule,
            location: None,
        }],
    );
    let diag_resp = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Diagnose,
            workspace_root: repo.0.to_string_lossy().into_owned(),
            ..NativeRequest::default()
        },
        Some(diag_graph),
    );
    assert!(diag_resp.ok, "{diag_resp:?}");
    let diag = diag_resp
        .result
        .and_then(|r| r.diagnose)
        .ok_or("missing diagnose")?;
    let culprit = diag
        .widening_culprits
        .iter()
        .find(|c| c.path == "libs/billing/src/calc.ts")
        .ok_or("missing billing culprit")?;
    assert_eq!(culprit.widened_projects, 3, "expected billing + ui + web");
    assert_eq!(culprit.widened_tasks, 3);
    Ok(())
}

fn cache_inputs_fixture() -> Result<(TempRepo, DependencyGraph), Box<dyn Error>> {
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["always:task", "clean:test", "broken:test", "scoped:test"] },
            "dynamicImportScopes": {
                "libs/scoped/src/loader.ts": ["libs/scoped/src/plugins/**"]
            }
        },
        "projects": [
            { "id": "always", "root": "libs/always", "fallbackDependencies": [] },
            { "id": "clean", "root": "libs/clean", "fallbackDependencies": [] },
            { "id": "broken", "root": "libs/broken", "fallbackDependencies": [] },
            { "id": "scoped", "root": "libs/scoped", "fallbackDependencies": [] }
        ],
        "tasks": [
            { "id": "always:task", "project": "always", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "always" } },
            { "id": "clean:test", "project": "clean", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
            { "id": "broken:test", "project": "broken", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
            { "id": "scoped:test", "project": "scoped", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
        ]
    });
    let repo = TempRepo::create(
        "fail-closed-cache-inputs",
        &manifest,
        &[
            ("libs/always/src/a.ts", "export const a = 1;\n"),
            ("libs/clean/src/c.ts", "export const c = 1;\n"),
            ("libs/broken/src/b.ts", "export const b = 1;\n"),
            ("libs/scoped/src/loader.ts", "export const l = 1;\n"),
            ("libs/scoped/src/plugins/p.ts", "export const p = 1;\n"),
            ("root-helper.ts", "export const helper = 1;\n"),
        ],
    )?;
    fs::write(repo.0.join("libs/clean/src/c.ts"), "export const c = 2;\n")?;
    fs::write(repo.0.join("libs/broken/src/b.ts"), "export const b = 2;\n")?;
    fs::write(
        repo.0.join("libs/scoped/src/loader.ts"),
        "export const l = 2;\n",
    )?;
    let changed = |p: &str, s: &str| ChangedModuleEvidence {
        path: p.to_owned(),
        changed_exports: BTreeSet::from([s.to_owned()]),
        every_hunk_is_attributed: true,
        semantic_change: true,
        type_only_change: false,
        module_eval_changed: false,
        changed_type_exports: None,
    };
    let graph = DependencyGraph::new(
        vec![
            mod_node("root-helper.ts", &["helper"], &[]),
            mod_node("libs/clean/src/c.ts", &["c"], &["root-helper.ts"]),
            mod_node("libs/broken/src/b.ts", &["b"], &[]),
            mod_node("libs/scoped/src/loader.ts", &["l"], &[]),
            mod_node("libs/scoped/src/plugins/p.ts", &["p"], &[]),
        ],
        vec![
            GraphUncertainty {
                path: "libs/broken/src/b.ts".into(),
                code: "nonliteral-dynamic-import".into(),
                message: "Unscoped dynamic import.".into(),
                scope: GraphUncertaintyScope::WholeWorkspace,
                location: None,
            },
            GraphUncertainty {
                path: "libs/scoped/src/loader.ts".into(),
                code: "nonliteral-dynamic-import".into(),
                message: "Scoped dynamic import.".into(),
                scope: GraphUncertaintyScope::WholeWorkspace,
                location: None,
            },
        ],
    )
    .with_changed_module_evidence(vec![
        changed("libs/clean/src/c.ts", "c"),
        changed("libs/broken/src/b.ts", "b"),
        changed("libs/scoped/src/loader.ts", "l"),
    ]);
    Ok((repo, graph))
}

#[test]
fn cache_inputs_fail_closed_on_always_fallback_missing_graph_and_blocking_uncertainties()
-> Result<(), Box<dyn Error>> {
    let (repo, graph) = cache_inputs_fixture()?;
    let plan = plan_with_graph(&repo.0, Some(graph.clone()))?;

    assert!(
        !task(&plan, "always:task")?
            .cache_inputs
            .as_ref()
            .ok_or("missing cache_inputs on always:task")?
            .cacheable
    );
    assert!(
        !task(&plan, "broken:test")?
            .cache_inputs
            .as_ref()
            .ok_or("missing cache_inputs on broken:test")?
            .cacheable
    );

    let clean_ci = task(&plan, "clean:test")?
        .cache_inputs
        .as_ref()
        .ok_or("missing cache_inputs on clean:test")?;
    assert!(clean_ci.cacheable);
    assert_eq!(clean_ci.project_roots, vec!["libs/clean"]);
    assert_eq!(clean_ci.extra_files, vec!["root-helper.ts"]);

    let scoped_ci = task(&plan, "scoped:test")?
        .cache_inputs
        .as_ref()
        .ok_or("missing cache_inputs on scoped:test")?;
    assert!(scoped_ci.cacheable);
    assert!(
        scoped_ci
            .impact_paths
            .contains(&"libs/scoped/src/plugins/**".to_owned())
    );

    let no_graph_plan = plan_with_graph(&repo.0, None)?;
    assert!(
        !task(&no_graph_plan, "clean:test")?
            .cache_inputs
            .as_ref()
            .ok_or("missing cache_inputs")?
            .cacheable
    );

    // Under `--all` with a healthy Oxc graph, sound `v4` cacheInputs are emitted for healthy tasks
    // while `always` tasks and tasks with blocking uncertainties still fail closed.
    let all_resp = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Plan,
            workspace_root: repo.0.to_string_lossy().into_owned(),
            all: true,
            ..NativeRequest::default()
        },
        Some(graph.clone()),
    );
    assert!(all_resp.ok, "{all_resp:?}");
    let all_plan = all_resp.result.ok_or("missing result")?.plan;
    assert!(
        !task(&all_plan, "always:task")?
            .cache_inputs
            .as_ref()
            .ok_or("missing cache_inputs")?
            .cacheable
    );
    assert!(
        !task(&all_plan, "broken:test")?
            .cache_inputs
            .as_ref()
            .ok_or("missing cache_inputs")?
            .cacheable
    );
    let all_clean_ci = task(&all_plan, "clean:test")?
        .cache_inputs
        .as_ref()
        .ok_or("missing cache_inputs on clean:test")?;
    assert!(all_clean_ci.cacheable);
    assert_eq!(all_clean_ci.project_roots, vec!["libs/clean"]);
    assert_eq!(all_clean_ci.extra_files, vec!["root-helper.ts"]);
    let all_scoped_ci = task(&all_plan, "scoped:test")?
        .cache_inputs
        .as_ref()
        .ok_or("missing cache_inputs on scoped:test")?;
    assert!(all_scoped_ci.cacheable);
    assert!(
        all_scoped_ci
            .impact_paths
            .contains(&"libs/scoped/src/plugins/**".to_owned())
    );

    // Under `--all` without a graph, every task fails closed (`cacheable = false`).
    let all_no_graph_resp = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Plan,
            workspace_root: repo.0.to_string_lossy().into_owned(),
            all: true,
            ..NativeRequest::default()
        },
        None,
    );
    assert!(all_no_graph_resp.ok, "{all_no_graph_resp:?}");
    let all_no_graph_plan = all_no_graph_resp.result.ok_or("missing result")?.plan;
    for decision in &all_no_graph_plan.tasks {
        assert!(
            !decision
                .cache_inputs
                .as_ref()
                .ok_or("runnable task must have cache_inputs")?
                .cacheable,
            "--all without graph must fail closed for {}",
            decision.id
        );
    }

    // Error-induced `evidence.full_fallback` (unowned changed path) fails closed even with a graph.
    fs::write(repo.0.join("unowned.ts"), "export const x = 1;\n")?;
    let err_fallback_plan = plan_with_graph(&repo.0, Some(graph))?;
    assert!(err_fallback_plan.scope.full_fallback);
    for decision in &err_fallback_plan.tasks {
        assert!(
            !decision
                .cache_inputs
                .as_ref()
                .ok_or("runnable task must have cache_inputs")?
                .cacheable,
            "error full_fallback task {} must fail closed",
            decision.id
        );
    }
    Ok(())
}
