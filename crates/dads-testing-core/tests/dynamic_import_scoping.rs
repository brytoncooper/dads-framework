//! Integration tests for local test-file uncertainty isolation and workspace.dynamicImportScopes.
use dads_testing_core::graph::{
    DependencyGraph, GraphUncertainty, GraphUncertaintyScope, ImportFact, ImportKind, ModuleNode,
    SourceSpan,
};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request_with_graph,
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

#[test]
fn unimported_test_file_dynamic_import_stays_local_to_owning_project_in_plan_and_diagnose()
-> Result<(), Box<dyn Error>> {
    let ws = TempWorkspace::create("local-test-dynamic-import", json!({}))?;
    fs::write(
        ws.0.join("packages/web/src/page.ts"),
        "export const p = 2;\n",
    )?;

    let graph = DependencyGraph::new(
        sample_nodes(),
        vec![GraphUncertainty {
            path: "packages/core/src/shared.test.ts".into(),
            code: "nonliteral-dynamic-import".into(),
            message: "Dynamic import is not a string literal.".into(),
            scope: GraphUncertaintyScope::WholeWorkspace,
            location: None,
        }],
    );

    let diag = execute_request_with_graph(
        base_request(&ws.0, Operation::Diagnose),
        Some(graph.clone()),
    )
    .result
    .and_then(|r| r.diagnose)
    .ok_or("missing diagnose payload")?;
    assert_eq!(diag.widening_culprits.len(), 1);
    assert_eq!(diag.widening_culprits[0].widened_projects, 1);
    assert_eq!(diag.widening_culprits[0].widened_tasks, 1);
    assert!(diag.summary.estimated_leaf_skip_percent > 30.0);

    let plan = execute_request_with_graph(
        NativeRequest {
            base: Some("HEAD".into()),
            ..base_request(&ws.0, Operation::Plan)
        },
        Some(graph),
    )
    .result
    .ok_or("missing plan")?
    .plan;
    let selected: BTreeSet<&str> = plan
        .tasks
        .iter()
        .filter(|t| t.decision == "run")
        .map(|t| t.id.as_str())
        .collect();
    assert_eq!(selected, BTreeSet::from(["core:test", "web:test"]));
    Ok(())
}

#[test]
fn dynamic_import_scopes_limit_widening_to_declared_prefixes_in_plan_and_diagnose()
-> Result<(), Box<dyn Error>> {
    let scopes = json!({
        "packages/core/src/shared.ts": ["packages/core/src/intents"]
    });
    let ws = TempWorkspace::create("dynamic-import-scopes", scopes)?;
    let graph = DependencyGraph::new(
        sample_nodes(),
        vec![GraphUncertainty {
            path: "packages/core/src/shared.ts".into(),
            code: "nonliteral-dynamic-import".into(),
            message: "Dynamic import is not a string literal.".into(),
            scope: GraphUncertaintyScope::WholeWorkspace,
            location: None,
        }],
    );

    let diag = execute_request_with_graph(
        base_request(&ws.0, Operation::Diagnose),
        Some(graph.clone()),
    )
    .result
    .and_then(|r| r.diagnose)
    .ok_or("missing diagnose payload")?;
    assert_eq!(diag.summary.whole_workspace_uncertainties, 0);
    assert!(diag.summary.estimated_leaf_skip_percent > 30.0);

    fs::write(
        ws.0.join("packages/web/src/page.ts"),
        "export const p = 2;\n",
    )?;
    let unrelated = selected_tasks(&ws.0, &graph)?;
    assert_eq!(unrelated, BTreeSet::from(["web:test".to_owned()]));

    fs::write(
        ws.0.join("packages/web/src/page.ts"),
        "export const p = 1;\n",
    )?;
    fs::write(
        ws.0.join("packages/core/src/intents/a.ts"),
        "export const a = 2;\n",
    )?;
    let in_scope = selected_tasks(&ws.0, &graph)?;
    assert_eq!(
        in_scope,
        BTreeSet::from([
            "app:test".to_owned(),
            "core:test".to_owned(),
            "web:test".to_owned()
        ])
    );

    // Modifying the scoped loader file itself must widen even when none of its
    // declared prefixes changed, so changing what a loader scans never false-skips.
    fs::write(
        ws.0.join("packages/core/src/intents/a.ts"),
        "export const a = 1;\n",
    )?;
    fs::write(
        ws.0.join("packages/core/src/shared.ts"),
        "export const s = 2;\n",
    )?;
    let loader_changed = selected_tasks(&ws.0, &graph)?;
    assert_eq!(
        loader_changed,
        BTreeSet::from([
            "app:test".to_owned(),
            "core:test".to_owned(),
            "web:test".to_owned()
        ])
    );
    Ok(())
}

fn selected_tasks(
    root: &Path,
    graph: &DependencyGraph,
) -> Result<BTreeSet<String>, Box<dyn Error>> {
    let plan = execute_request_with_graph(
        NativeRequest {
            base: Some("HEAD".into()),
            ..base_request(root, Operation::Plan)
        },
        Some(graph.clone()),
    )
    .result
    .ok_or("missing plan")?
    .plan;
    Ok(plan
        .tasks
        .into_iter()
        .filter(|t| t.decision == "run")
        .map(|t| t.id)
        .collect())
}

fn sample_nodes() -> Vec<ModuleNode> {
    vec![
        module_node("packages/core/src/shared.ts", &[]),
        module_node("packages/core/src/intents/a.ts", &[]),
        module_node(
            "packages/core/src/shared.test.ts",
            &["packages/core/src/shared.ts"],
        ),
        module_node("packages/app/src/service.ts", &[]),
        module_node(
            "packages/app/src/service.test.ts",
            &["packages/app/src/service.ts"],
        ),
        module_node("packages/web/src/page.ts", &[]),
        module_node(
            "packages/web/src/view.test.ts",
            &["packages/web/src/page.ts"],
        ),
    ]
}

fn module_node(path: &str, imports: &[&str]) -> ModuleNode {
    ModuleNode {
        path: path.to_owned(),
        language: "typescript".to_owned(),
        declarations: Vec::new(),
        references: Vec::new(),
        imports: imports
            .iter()
            .map(|target| ImportFact {
                specifier: (*target).to_owned(),
                span: SourceSpan { start: 0, end: 1 },
                kind: ImportKind::Static,
                type_only: false,
                requested_symbols: BTreeSet::new(),
                namespace_import: false,
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

fn base_request(workspace_root: &Path, operation: Operation) -> NativeRequest {
    NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation,
        workspace_root: workspace_root.to_string_lossy().into_owned(),
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
    }
}

struct TempWorkspace(PathBuf);

impl TempWorkspace {
    fn create(
        label: &str,
        dynamic_import_scopes: serde_json::Value,
    ) -> Result<Self, Box<dyn Error>> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "dads-dyn-{label}-{}-{nonce}-{seq}",
            std::process::id()
        ));
        for sub in [
            "packages/core/src/intents",
            "packages/app/src",
            "packages/web/src",
        ] {
            fs::create_dir_all(dir.join(sub))?;
        }
        let manifest = json!({
            "schemaVersion": 1,
            "workspace": {
                "root": ".",
                "fullFallback": { "taskIds": ["core:test", "app:test", "web:test"] },
                "dynamicImportScopes": dynamic_import_scopes
            },
            "projects": [
                { "id": "core", "root": "packages/core", "fallbackDependencies": [] },
                { "id": "app", "root": "packages/app", "fallbackDependencies": ["core"] },
                { "id": "web", "root": "packages/web", "fallbackDependencies": ["core"] }
            ],
            "tasks": [
                reach_task("core:test", "core"),
                reach_task("app:test", "app"),
                reach_task("web:test", "web")
            ]
        });
        fs::write(
            dir.join("dads.testing.json"),
            serde_json::to_string_pretty(&manifest)?,
        )?;
        for (file, content) in [
            ("packages/core/src/shared.ts", "export const s = 1;\n"),
            ("packages/core/src/intents/a.ts", "export const a = 1;\n"),
            ("packages/core/src/shared.test.ts", "export const t = 1;\n"),
            ("packages/app/src/service.ts", "export const v = 1;\n"),
            ("packages/app/src/service.test.ts", "export const t = 1;\n"),
            ("packages/web/src/page.ts", "export const p = 1;\n"),
            ("packages/web/src/view.test.ts", "export const t = 1;\n"),
        ] {
            fs::write(dir.join(file), content)?;
        }
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

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn reach_task(id: &str, project: &str) -> serde_json::Value {
    json!({
        "id": id,
        "project": project,
        "kind": "test",
        "execution": { "executable": "true", "args": [], "fileNarrowing": { "suffixes": [".test.ts"] } },
        "dependsOn": [],
        "impact": { "mode": "reachability", "paths": [] }
    })
}

fn run_git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    if !status.success() {
        return Err(format!("git {args:?} failed").into());
    }
    Ok(())
}
