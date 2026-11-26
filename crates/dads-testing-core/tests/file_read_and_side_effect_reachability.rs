//! Targeted tests for `ImportKind::FileRead` direct-only reachability, zero-export side-effect
//! propagation in `propagate_own_exports`, `FileRead` `cacheInputs` isolation, and boundaries.

use dads_testing_core::graph::{
    ChangedModuleEvidence, DependencyGraph, ImportFact, ImportKind, ModuleNode, SourceSpan,
    SymbolFact,
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
            "dads-fileread-{label}-{}-{nonce}-{seq}",
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

fn make_import(
    target: &str,
    kind: ImportKind,
    requested: &[&str],
    namespace_import: bool,
    reexport_all: bool,
) -> ImportFact {
    ImportFact {
        specifier: if kind == ImportKind::FileRead {
            format!("fs:{target}")
        } else {
            target.to_owned()
        },
        span: SourceSpan { start: 0, end: 1 },
        kind,
        type_only: false,
        requested_symbols: requested.iter().map(|s| (*s).to_owned()).collect(),
        namespace_import,
        reexport_all,
        reexport_namespace: None,
        resolved_path: Some(target.to_owned()),
        position: None,
        export_deps: None,
        member_reads: None,
    }
}

fn make_node(path: &str, exports: &[&str], imports: Vec<ImportFact>) -> ModuleNode {
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
        imports,
    }
}

fn changed_evidence(path: &str, exports: &[&str]) -> ChangedModuleEvidence {
    ChangedModuleEvidence {
        path: path.to_owned(),
        changed_exports: exports.iter().map(|s| (*s).to_owned()).collect(),
        every_hunk_is_attributed: true,
        semantic_change: true,
        type_only_change: false,
        module_eval_changed: false,
        changed_type_exports: None,
    }
}

#[test]
fn file_read_follows_direct_edits_and_never_propagates_transitively_or_emits_zero_export_uncertainty()
 {
    let nodes = vec![
        make_node("libs/ui/src/btn.tsx", &["Btn"], vec![]),
        make_node(
            "apps/web/src/main.tsx",
            &[],
            vec![make_import(
                "libs/ui/src/btn.tsx",
                ImportKind::Static,
                &["Btn"],
                false,
                false,
            )],
        ),
        make_node(
            "apps/web/src/locale.test.tsx",
            &[],
            vec![make_import(
                "apps/web/src/main.tsx",
                ImportKind::FileRead,
                &[],
                false,
                false,
            )],
        ),
        make_node(
            "scripts/helper.mjs",
            &["readMain"],
            vec![make_import(
                "apps/web/src/main.tsx",
                ImportKind::FileRead,
                &[],
                false,
                false,
            )],
        ),
        make_node(
            "scripts/audit.test.mjs",
            &[],
            vec![make_import(
                "scripts/helper.mjs",
                ImportKind::Static,
                &["readMain"],
                false,
                false,
            )],
        ),
    ];

    // 1. Transitive JS edit to `btn.tsx`: reaches `main.tsx`, must NOT follow `FileRead` edges to
    //    `locale.test.tsx` or `scripts/helper.mjs`, and must emit ZERO uncertainties.
    let transitive_graph = DependencyGraph::new(nodes.clone(), vec![])
        .with_changed_module_evidence(vec![changed_evidence("libs/ui/src/btn.tsx", &["Btn"])]);
    let transitive = transitive_graph.symbol_reachability_runtime(["libs/ui/src/btn.tsx".into()]);
    assert!(transitive.paths.contains("apps/web/src/main.tsx"));
    assert!(!transitive.paths.contains("apps/web/src/locale.test.tsx"));
    assert!(!transitive.paths.contains("scripts/helper.mjs"));
    assert!(!transitive.paths.contains("scripts/audit.test.mjs"));
    assert!(
        transitive.uncertainties.is_empty(),
        "unexpected uncertainties: {:?}",
        transitive.uncertainties
    );

    // 2. Direct edit to `main.tsx` (0 exports): follows `FileRead` to `locale.test.tsx` and
    //    `scripts/helper.mjs`, propagates `readMain` to `scripts/audit.test.mjs`, ZERO uncertainties!
    let direct_graph = DependencyGraph::new(nodes, vec![])
        .with_changed_module_evidence(vec![changed_evidence("apps/web/src/main.tsx", &[])]);
    let direct = direct_graph.symbol_reachability_runtime(["apps/web/src/main.tsx".into()]);
    assert!(direct.paths.contains("apps/web/src/main.tsx"));
    assert!(direct.paths.contains("apps/web/src/locale.test.tsx"));
    assert!(direct.paths.contains("scripts/helper.mjs"));
    assert!(direct.paths.contains("scripts/audit.test.mjs"));
    assert!(
        direct.uncertainties.is_empty(),
        "direct edit to 0-export FileRead target must not emit uncertainty: {:?}",
        direct.uncertainties
    );
}

#[test]
fn propagate_own_exports_follows_pure_side_effect_imports_without_widening() {
    let nodes = vec![
        make_node("lib/leaf.ts", &["value"], vec![]),
        make_node(
            "app/side-effect.ts",
            &[],
            vec![make_import(
                "lib/leaf.ts",
                ImportKind::Static,
                &["value"],
                false,
                false,
            )],
        ),
        make_node(
            "app/runtime-consumer.ts",
            &["run"],
            vec![make_import(
                "app/side-effect.ts",
                ImportKind::Runtime,
                &[],
                false,
                false,
            )],
        ),
        make_node(
            "app/static-bare-consumer.ts",
            &["bare"],
            vec![make_import(
                "app/side-effect.ts",
                ImportKind::Static,
                &[],
                false,
                false,
            )],
        ),
        make_node(
            "app/downstream.test.ts",
            &[],
            vec![
                make_import(
                    "app/runtime-consumer.ts",
                    ImportKind::Static,
                    &["run"],
                    false,
                    false,
                ),
                make_import(
                    "app/static-bare-consumer.ts",
                    ImportKind::Static,
                    &["bare"],
                    false,
                    false,
                ),
            ],
        ),
    ];

    let graph = DependencyGraph::new(nodes, vec![])
        .with_changed_module_evidence(vec![changed_evidence("lib/leaf.ts", &["value"])]);
    let reached = graph.symbol_reachability_runtime(["lib/leaf.ts".into()]);
    assert!(reached.paths.contains("app/side-effect.ts"));
    assert!(reached.paths.contains("app/runtime-consumer.ts"));
    assert!(reached.paths.contains("app/static-bare-consumer.ts"));
    assert!(reached.paths.contains("app/downstream.test.ts"));
    assert!(
        reached.uncertainties.is_empty(),
        "pure side-effect imports must propagate cleanly without widening: {:?}",
        reached.uncertainties
    );
}

#[test]
fn propagate_own_exports_keeps_named_imports_from_zero_export_module_fail_closed() {
    let nodes = vec![
        make_node("lib/leaf.ts", &["value"], vec![]),
        make_node(
            "app/zero-export.ts",
            &[],
            vec![make_import(
                "lib/leaf.ts",
                ImportKind::Static,
                &["value"],
                false,
                false,
            )],
        ),
        make_node(
            "app/bad-consumer.ts",
            &["x"],
            vec![make_import(
                "app/zero-export.ts",
                ImportKind::Static,
                &["mystery"],
                false,
                false,
            )],
        ),
    ];
    let graph = DependencyGraph::new(nodes, vec![])
        .with_changed_module_evidence(vec![changed_evidence("lib/leaf.ts", &["value"])]);
    let reached = graph.symbol_reachability_runtime(["lib/leaf.ts".into()]);
    assert!(
        reached.uncertainties.iter().any(|u| {
            u.path == "app/zero-export.ts" && u.code == "unattributed-transitive-export"
        })
    );
}

fn setup_file_read_project_graph_repo() -> Result<(TempRepo, Vec<ModuleNode>), Box<dyn Error>> {
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["web:test", "scripts:test", "other:test"] }
        },
        "projects": [
            { "id": "ui", "root": "libs/ui", "fallbackDependencies": [] },
            { "id": "web", "root": "apps/web", "fallbackDependencies": [] },
            { "id": "settings", "root": "settings", "fallbackDependencies": [] },
            { "id": "scripts", "root": "scripts", "fallbackDependencies": [] },
            { "id": "other", "root": "libs/other", "fallbackDependencies": ["scripts"] }
        ],
        "tasks": [
            { "id": "web:test", "project": "web", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
            { "id": "scripts:test", "project": "scripts", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
            { "id": "other:test", "project": "other", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
        ]
    });
    let repo = TempRepo::create(
        "project-graph-cache",
        &manifest,
        &[
            ("libs/ui/src/btn.ts", "export const Btn = 1;\n"),
            ("apps/web/src/main.ts", "export const main = 1;\n"),
            ("apps/web/src/raw.json", "{\"ok\":true}\n"),
            ("settings/rules/r1.txt", "ok\n"),
            ("scripts/audit.mjs", "export const audit = 1;\n"),
            ("libs/other/src/other.ts", "export const other = 1;\n"),
        ],
    )?;
    let dir_asset = ModuleNode {
        path: "settings/rules/".into(),
        language: "asset".into(),
        declarations: vec![SymbolFact {
            name: "__asset__".into(),
            span: SourceSpan { start: 0, end: 0 },
        }],
        references: Vec::new(),
        imports: Vec::new(),
    };
    let nodes = vec![
        make_node("libs/ui/src/btn.ts", &["Btn"], vec![]),
        make_node(
            "apps/web/src/main.ts",
            &["main"],
            vec![
                make_import(
                    "libs/ui/src/btn.ts",
                    ImportKind::Static,
                    &["Btn"],
                    false,
                    false,
                ),
                make_import("settings/rules/", ImportKind::FileRead, &[], false, false),
            ],
        ),
        dir_asset,
        make_node(
            "scripts/audit.mjs",
            &["audit"],
            vec![make_import(
                "apps/web/src/main.ts",
                ImportKind::FileRead,
                &[],
                false,
                false,
            )],
        ),
        make_node("libs/other/src/other.ts", &["other"], vec![]),
    ];
    Ok((repo, nodes))
}

#[test]
fn file_read_edges_do_not_create_project_fallback_deps_or_pull_owner_roots_into_cache_inputs()
-> Result<(), Box<dyn Error>> {
    let (repo, nodes) = setup_file_read_project_graph_repo()?;

    // 1. An uncovered non-code change in `web` must NOT widen into `scripts` or `other`!
    fs::write(repo.0.join("apps/web/src/raw.json"), "{\"ok\":false}\n")?;
    let plan = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Plan,
            workspace_root: repo.0.to_string_lossy().into_owned(),
            ..NativeRequest::default()
        },
        Some(DependencyGraph::new(nodes.clone(), vec![])),
    )
    .result
    .ok_or("missing plan")?
    .plan;
    let decision = |id: &str| {
        plan.tasks
            .iter()
            .find(|t| t.id == id)
            .map(|t| t.decision.as_str())
    };
    assert_eq!(decision("web:test"), Some("run"));
    assert_eq!(decision("scripts:test"), Some("skip-proven-unaffected"));
    assert_eq!(decision("other:test"), Some("skip-proven-unaffected"));

    // 2. Under `--all`, `scripts:test` puts `apps/web/src/main.ts` in `extraFiles` without pulling
    //    `apps/web` or `libs/ui` into `projectRoots`, and `web:test` puts `settings/rules/` in
    //    `impactPaths` without pulling `settings` into `projectRoots`.
    let all_plan = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Plan,
            workspace_root: repo.0.to_string_lossy().into_owned(),
            all: true,
            ..NativeRequest::default()
        },
        Some(DependencyGraph::new(nodes, vec![])),
    )
    .result
    .ok_or("missing all plan")?
    .plan;
    let scripts_ci = all_plan
        .tasks
        .iter()
        .find(|t| t.id == "scripts:test")
        .and_then(|t| t.cache_inputs.as_ref())
        .ok_or("missing scripts:test cacheInputs")?;
    assert!(scripts_ci.cacheable);
    assert_eq!(scripts_ci.project_roots, vec!["scripts"]);
    assert_eq!(scripts_ci.extra_files, vec!["apps/web/src/main.ts"]);

    let web_ci = all_plan
        .tasks
        .iter()
        .find(|t| t.id == "web:test")
        .and_then(|t| t.cache_inputs.as_ref())
        .ok_or("missing web:test cacheInputs")?;
    assert!(web_ci.cacheable);
    assert_eq!(web_ci.project_roots, vec!["apps/web", "libs/ui"]);
    assert_eq!(web_ci.impact_paths, vec!["settings/rules"]);
    Ok(())
}

#[test]
fn check_boundaries_ignores_file_read_edges_even_across_disallowed_tags()
-> Result<(), Box<dyn Error>> {
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["ui:test"] },
            "boundaries": {
                "depConstraints": [{
                    "sourceTag": "env:browser",
                    "notDependOnLibsWithTags": ["env:server"]
                }]
            }
        },
        "projects": [
            { "id": "ui", "root": "libs/ui", "fallbackDependencies": [], "tags": ["env:browser"] },
            { "id": "server", "root": "libs/server", "fallbackDependencies": [], "tags": ["env:server"] }
        ],
        "tasks": [
            { "id": "ui:test", "project": "ui", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
        ]
    });
    let repo = TempRepo::create(
        "boundaries-file-read",
        &manifest,
        &[
            ("libs/ui/src/audit.ts", "export const a = 1;\n"),
            ("libs/server/src/index.ts", "export const s = 1;\n"),
        ],
    )?;
    let mut ui_node = make_node("libs/ui/src/audit.ts", &["a"], vec![]);
    // Deliberately use a relative specifier (without `fs:` prefix) to verify `ImportKind::FileRead`
    // itself is ignored by boundaries, not just the `fs:` specifier prefix.
    ui_node.imports.push(ImportFact {
        specifier: "../../server/src/index.ts".into(),
        span: SourceSpan { start: 0, end: 1 },
        kind: ImportKind::FileRead,
        type_only: false,
        requested_symbols: BTreeSet::new(),
        namespace_import: false,
        reexport_all: false,
        reexport_namespace: None,
        resolved_path: Some("libs/server/src/index.ts".into()),
        position: None,
        export_deps: None,
        member_reads: None,
    });
    let graph = DependencyGraph::new(
        vec![
            ui_node,
            make_node("libs/server/src/index.ts", &["s"], vec![]),
        ],
        vec![],
    );
    let resp = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::CheckBoundaries,
            workspace_root: repo.0.to_string_lossy().into_owned(),
            ..NativeRequest::default()
        },
        Some(graph),
    );
    assert!(resp.ok, "{resp:?}");
    let boundaries = resp
        .result
        .and_then(|r| r.boundaries)
        .ok_or("missing boundaries")?;
    assert!(
        boundaries.violations.is_empty(),
        "FileRead edges must never emit boundary violations: {:?}",
        boundaries.violations
    );
    Ok(())
}
