//! Integration tests for the read-only `diagnose` Coupling & Precision X-Ray operation.
use dads_testing_core::graph::{
    DependencyGraph, GraphUncertainty, GraphUncertaintyScope, ImportFact, ImportKind, LineColumn,
    ModuleNode, SourceLocation, SourceSpan,
};
use dads_testing_core::{
    DiagnoseResult, IssueScope, NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION,
    RemediationSafety, execute_request_with_graph,
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
fn diagnoses_culprits_hotspots_and_fallback_traps_without_a_diff() -> Result<(), Box<dyn Error>> {
    let ws = TempRepo::create("full")?;
    let graph = build_sample_graph();
    let response = execute_request_with_graph(diagnose_request(&ws.0), Some(graph));
    assert!(response.ok, "{response:?}");
    let result = response.result.ok_or("missing operation result")?;
    assert_eq!(result.operation, "diagnose");
    let diag = result.diagnose.ok_or("missing diagnose payload")?;

    assert_summary(&diag);
    assert_culprits(&diag);
    assert_hotspots(&diag);
    assert_traps(&diag)?;
    Ok(())
}

#[test]
fn plan_wire_response_omits_diagnose_field() -> Result<(), Box<dyn Error>> {
    let ws = TempRepo::create("wire")?;
    let response = execute_request_with_graph(
        NativeRequest {
            operation: Operation::Plan,
            all: true,
            ..diagnose_request(&ws.0)
        },
        None,
    );
    assert!(response.ok, "{response:?}");
    let value = serde_json::to_value(&response)?;
    let result_obj = value["result"]
        .as_object()
        .ok_or("result must serialize as an object")?;
    assert!(!result_obj.contains_key("diagnose"));
    Ok(())
}

#[test]
fn handles_large_graph_and_caps_rankings() -> Result<(), Box<dyn Error>> {
    let ws = TempRepo::create("large")?;
    let mut nodes = Vec::new();
    let mut uncertainties = Vec::new();
    nodes.push(module_node("packages/core/src/hub.ts", &[]));
    for i in 0..140 {
        let src = format!("packages/app/src/mod_{i:03}.ts");
        let target = if i % 5 == 0 {
            vec!["packages/core/src/hub.ts"]
        } else {
            Vec::new()
        };
        nodes.push(module_node(&src, &target));
        let test = format!("packages/app/src/mod_{i:03}.test.ts");
        nodes.push(module_node(&test, &[src.as_str()]));
    }
    for i in 0..60 {
        uncertainties.push(GraphUncertainty {
            path: format!("packages/app/src/mod_{i:03}.ts"),
            code: "nonliteral-dynamic-import".into(),
            message: "dynamic import".into(),
            scope: GraphUncertaintyScope::ReachedModule,
            location: Some(SourceLocation {
                span: SourceSpan { start: 0, end: 10 },
                position: LineColumn {
                    line: i + 1,
                    column: 1,
                },
            }),
        });
    }
    let graph = DependencyGraph::new(nodes, uncertainties);
    let response = execute_request_with_graph(diagnose_request(&ws.0), Some(graph));
    assert!(response.ok, "{response:?}");
    let diag = response
        .result
        .and_then(|r| r.diagnose)
        .ok_or("missing diagnose payload")?;

    assert_eq!(diag.summary.total_uncertainties, 60);
    assert_eq!(diag.widening_culprits.len(), 50);
    assert_eq!(diag.coupling_hotspots.len(), 15);
    assert_eq!(diag.coupling_hotspots[0].path, "packages/core/src/hub.ts");
    assert_eq!(diag.coupling_hotspots[0].reached_test_files, 28);
    assert!(diag.summary.potential_leaf_skip_percent > 90.0);
    assert!(diag.summary.estimated_leaf_skip_percent < diag.summary.potential_leaf_skip_percent);
    Ok(())
}

#[test]
fn separates_runtime_from_type_only_hotspots_and_finds_deep_transitive_roots()
-> Result<(), Box<dyn Error>> {
    let ws = TempRepo::create("runtime-vs-types")?;
    let mut nodes = vec![
        module_node("packages/core/src/deep_root.ts", &[]),
        module_node("packages/core/src/types_only.ts", &[]),
        module_node(
            "packages/core/src/barrel_a.ts",
            &["packages/core/src/deep_root.ts"],
        ),
        module_node(
            "packages/core/src/barrel_b.ts",
            &["packages/core/src/deep_root.ts"],
        ),
    ];
    for i in 0..80 {
        let barrel = if i % 2 == 0 {
            "packages/core/src/barrel_a.ts"
        } else {
            "packages/core/src/barrel_b.ts"
        };
        let test = format!("packages/app/src/case_{i:03}.test.ts");
        let mut node = module_node(&test, &[barrel]);
        node.imports
            .push(type_only_import("packages/core/src/types_only.ts"));
        nodes.push(node);
    }
    let graph = DependencyGraph::new(nodes, Vec::new());
    let response = execute_request_with_graph(diagnose_request(&ws.0), Some(graph));
    assert!(response.ok, "{response:?}");
    let diag = response
        .result
        .and_then(|r| r.diagnose)
        .ok_or("missing diagnose payload")?;

    // Deep root has only 2 direct importers yet reaches all 80 runtime test files — never missed.
    assert_eq!(
        diag.coupling_hotspots[0].path,
        "packages/core/src/deep_root.ts"
    );
    assert_eq!(diag.coupling_hotspots[0].reached_test_files, 80);
    assert_eq!(diag.coupling_hotspots[0].typecheck_reached_test_files, 80);

    // Pure type-only hub has 0 runtime test reach, 80 typecheck reach, and safe type-only advice.
    let types_hotspot = diag
        .coupling_hotspots
        .iter()
        .find(|h| h.path == "packages/core/src/types_only.ts")
        .ok_or("missing type-only hotspot")?;
    assert_eq!(types_hotspot.reached_test_files, 0);
    assert_eq!(types_hotspot.typecheck_reached_test_files, 80);
    assert!(
        types_hotspot
            .remediation
            .action
            .contains("Type-only coupling")
    );
    // With zero uncertainties, effective leaf skip equals potential leaf skip exactly.
    assert_eq!(
        diag.summary.estimated_leaf_skip_percent,
        diag.summary.potential_leaf_skip_percent
    );
    Ok(())
}

#[test]
fn leaf_owned_whole_workspace_uncertainty_widens_only_its_own_closure() -> Result<(), Box<dyn Error>>
{
    let ws = TempRepo::create("leaf-whole-ws")?;
    let nodes = vec![
        module_node("packages/core/src/shared.ts", &[]),
        module_node(
            "packages/core/src/shared.test.ts",
            &["packages/core/src/shared.ts"],
        ),
        module_node("packages/app/src/leaf.ts", &[]),
        module_node(
            "packages/app/src/leaf.test.ts",
            &["packages/app/src/leaf.ts"],
        ),
        module_node("packages/web/src/page.ts", &[]),
        module_node(
            "packages/web/src/page.test.ts",
            &["packages/web/src/page.ts"],
        ),
    ];
    let uncertainties = vec![
        GraphUncertainty {
            path: "packages/app/src/leaf.ts".into(),
            code: "nonliteral-dynamic-import".into(),
            message: "Dynamic import is not a string literal.".into(),
            scope: GraphUncertaintyScope::WholeWorkspace,
            location: None,
        },
        GraphUncertainty {
            path: "packages/app/eslint.config.mjs".into(),
            code: "ambiguous-default-export".into(),
            message: "A default export does not have a stable named-import identity in this graph."
                .into(),
            scope: GraphUncertaintyScope::ReachedModule,
            location: None,
        },
        GraphUncertainty {
            path: "packages/web/vitest.config.mts".into(),
            code: "ambiguous-default-export".into(),
            message: "A default export does not have a stable named-import identity in this graph."
                .into(),
            scope: GraphUncertaintyScope::ReachedModule,
            location: None,
        },
    ];
    let graph = DependencyGraph::new(nodes, uncertainties);
    let response = execute_request_with_graph(diagnose_request(&ws.0), Some(graph));
    assert!(response.ok, "{response:?}");
    let diag = response
        .result
        .and_then(|r| r.diagnose)
        .ok_or("missing diagnose payload")?;

    // Tool configs (`eslint.config.mjs`, `vitest.config.mts`) are not flagged as actionable culprits.
    assert_eq!(diag.widening_culprits.len(), 1);
    let culprit = &diag.widening_culprits[0];
    assert_eq!(culprit.path, "packages/app/src/leaf.ts");
    // `app` is a leaf project with zero dependents, so its owned dynamic import widens ONLY `app`,
    // matching `plan` behavior instead of claiming all 3 projects / 0% skip.
    assert_eq!(culprit.widened_projects, 1);
    assert_eq!(culprit.widened_tasks, 1);
    assert_eq!(culprit.widened_test_files, 1);
    assert!(
        diag.summary.estimated_leaf_skip_percent > 20.0,
        "expected non-zero effective skip for unrelated projects, got {}",
        diag.summary.estimated_leaf_skip_percent
    );
    Ok(())
}

fn assert_summary(diag: &DiagnoseResult) {
    assert_eq!(diag.schema_version, PROTOCOL_SCHEMA_VERSION);
    assert_eq!(diag.summary.total_modules, 8);
    assert_eq!(diag.summary.total_projects, 3);
    assert_eq!(diag.summary.total_tasks, 3);
    assert_eq!(diag.summary.total_test_files, 4);
    assert_eq!(diag.summary.total_uncertainties, 3);
    assert_eq!(diag.summary.whole_workspace_uncertainties, 1);
    // dads.testing.json is an intentional root policy file and is excluded from fallback traps.
    assert_eq!(diag.summary.unowned_tracked_files, 3);
    assert_eq!(diag.summary.non_code_uncovered_files, 2);
    // Whole-workspace uncertainty widens all 3 reachability projects today (0% effective skip),
    // while fixing the culprits unlocks >40% potential leaf skip.
    assert_eq!(diag.summary.estimated_leaf_skip_percent, 0.0);
    assert!(diag.summary.potential_leaf_skip_percent > 40.0);
    assert!(diag.summary.potential_leaf_skip_percent < 90.0);
}

fn assert_culprits(diag: &DiagnoseResult) {
    assert_eq!(diag.widening_culprits.len(), 3);
    let first = &diag.widening_culprits[0];
    assert_eq!(first.code, "workspace-tsconfig-error");
    assert_eq!(first.scope, IssueScope::Workspace);
    assert_eq!(first.widened_projects, 3);
    assert_eq!(first.widened_tasks, 3);
    assert_eq!(first.widened_test_files, 4);

    let second = &diag.widening_culprits[1];
    assert_eq!(second.code, "nonliteral-dynamic-import");
    assert_eq!(second.scope, IssueScope::Module);
    assert_eq!(second.project.as_deref(), Some("core"));
    assert_eq!(second.line, Some(12));
    assert_eq!(second.column, Some(5));
    assert_eq!(second.widened_projects, 3);
    assert_eq!(second.widened_tasks, 3);
    assert_eq!(second.widened_test_files, 4);

    let third = &diag.widening_culprits[2];
    assert_eq!(third.code, "unresolved-bare-module");
    assert_eq!(third.project.as_deref(), Some("app"));
    assert_eq!(third.widened_projects, 1);
    assert_eq!(third.widened_tasks, 1);
    assert_eq!(third.widened_test_files, 2);
}

fn assert_hotspots(diag: &DiagnoseResult) {
    assert!(!diag.coupling_hotspots.is_empty());
    let top = &diag.coupling_hotspots[0];
    assert_eq!(top.path, "packages/core/src/shared.ts");
    assert_eq!(top.project.as_deref(), Some("core"));
    assert_eq!(top.reached_test_files, 3);
    assert_eq!(top.reached_projects, 3);
    assert_eq!(top.reached_test_percent, 75.0);
}

fn assert_traps(diag: &DiagnoseResult) -> Result<(), Box<dyn Error>> {
    let docs_trap = diag
        .fallback_traps
        .iter()
        .find(|t| {
            t.kind == "unowned-directory"
                && t.prefix == "docs/"
                && t.file_count == 2
                && t.project.is_none()
        })
        .ok_or("missing docs/ trap")?;
    assert_eq!(docs_trap.remediation.safety, RemediationSafety::Safe);

    let mobile_trap = diag
        .fallback_traps
        .iter()
        .find(|t| t.kind == "unowned-directory" && t.prefix == "apps/mobile/")
        .ok_or("missing apps/mobile/ trap")?;
    assert_eq!(
        mobile_trap.remediation.safety,
        RemediationSafety::VerifyBeforeChanging
    );

    let json_trap = diag
        .fallback_traps
        .iter()
        .find(|t| {
            t.kind == "non-code-in-reachability-project"
                && t.prefix == "*.json in app"
                && t.file_count == 2
                && t.project.as_deref() == Some("app")
        })
        .ok_or("missing *.json in app trap")?;
    assert_eq!(
        json_trap.remediation.safety,
        RemediationSafety::KeepWidenedUnlessVerified
    );
    assert!(json_trap.remediation.caution.contains("NEVER"));

    assert!(
        !diag
            .fallback_traps
            .iter()
            .any(|t| t.prefix == "./" || t.prefix.contains("*.md") || t.prefix.contains("*.sql"))
    );
    Ok(())
}

fn build_sample_graph() -> DependencyGraph {
    let nodes = vec![
        module_node("packages/core/src/shared.ts", &[]),
        module_node("packages/core/src/leaf.ts", &[]),
        module_node(
            "packages/core/src/shared.test.ts",
            &["packages/core/src/shared.ts"],
        ),
        module_node(
            "packages/app/src/service.ts",
            &["packages/core/src/shared.ts"],
        ),
        module_node(
            "packages/app/src/service.test.ts",
            &["packages/app/src/service.ts"],
        ),
        module_node("packages/app/src/isolated.ts", &[]),
        module_node(
            "packages/app/src/isolated.test.ts",
            &["packages/app/src/isolated.ts"],
        ),
        module_node(
            "packages/web/src/view.test.ts",
            &["packages/core/src/shared.ts"],
        ),
    ];
    let uncertainties = vec![
        GraphUncertainty {
            path: "packages/app/src/service.ts".into(),
            code: "unresolved-bare-module".into(),
            message: "Cannot resolve bare module.".into(),
            scope: GraphUncertaintyScope::ReachedModule,
            location: None,
        },
        GraphUncertainty {
            path: "packages/core/src/shared.ts".into(),
            code: "nonliteral-dynamic-import".into(),
            message: "Dynamic import is not a string literal.".into(),
            scope: GraphUncertaintyScope::ReachedModule,
            location: Some(SourceLocation {
                span: SourceSpan { start: 10, end: 25 },
                position: LineColumn {
                    line: 12,
                    column: 5,
                },
            }),
        },
        GraphUncertainty {
            path: "packages/core/tsconfig.json".into(),
            code: "workspace-tsconfig-error".into(),
            message: "Could not read tsconfig.".into(),
            scope: GraphUncertaintyScope::WholeWorkspace,
            location: None,
        },
    ];
    DependencyGraph::new(nodes, uncertainties)
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

fn type_only_import(target: &str) -> ImportFact {
    ImportFact {
        specifier: target.to_owned(),
        span: SourceSpan { start: 0, end: 1 },
        kind: ImportKind::Static,
        type_only: true,
        requested_symbols: BTreeSet::new(),
        namespace_import: false,
        reexport_all: false,
        reexport_namespace: None,
        resolved_path: Some(target.to_owned()),
        position: None,
        export_deps: None,
        member_reads: None,
    }
}

fn diagnose_request(workspace_root: &Path) -> NativeRequest {
    NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Diagnose,
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

struct TempRepo(PathBuf);

impl TempRepo {
    fn create(label: &str) -> Result<Self, Box<dyn Error>> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "dads-diagnose-{label}-{}-{nonce}-{seq}",
            std::process::id()
        ));
        for sub in [
            "packages/core/src",
            "packages/core/migrations",
            "packages/app/src",
            "packages/web/src",
            "docs",
            "apps/mobile/src",
        ] {
            fs::create_dir_all(dir.join(sub))?;
        }
        let manifest = json!({
            "schemaVersion": 1,
            "workspace": {
                "root": ".",
                "fullFallback": { "taskIds": ["core:test", "app:test", "web:test"] },
                "nonCodeSuffixes": [".md"],
                "sql": { "migrationRoots": ["packages/core/migrations"] }
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
        for file in [
            "packages/core/src/shared.ts",
            "packages/core/src/shared.test.ts",
            "packages/core/migrations/001.sql",
            "packages/app/src/service.ts",
            "packages/app/src/service.test.ts",
            "packages/app/src/fixture-a.json",
            "packages/app/src/fixture-b.json",
            "packages/app/README.md",
            "packages/web/src/view.test.ts",
            "docs/guide.md",
            "docs/faq.md",
            "apps/mobile/src/App.tsx",
        ] {
            fs::write(dir.join(file), "// tracked\n")?;
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

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn reach_task(id: &str, project: &str) -> serde_json::Value {
    json!({
        "id": id,
        "project": project,
        "kind": "test",
        "execution": {
            "executable": "true",
            "args": [],
            "fileNarrowing": { "suffixes": [".test.ts"] }
        },
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
