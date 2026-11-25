//! Unit and protocol tests for `Operation::Hotspots`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

use dads_testing_core::graph::{
    DependencyGraph, ImportFact, ImportKind, ModuleNode, SourceSpan, SymbolFact,
};
use dads_testing_core::{
    HotspotsOptions, NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request_with_graph,
};
use serde_json::json;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "dads-hotspots-{label}-{}-{nonce}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn write(&self, rel: &str, content: &str) {
        let path = self.0.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn manifest_json() -> String {
    json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["core:test", "app-a:test", "app-b:test"] }
        },
        "projects": [
            { "id": "core", "root": "packages/core", "fallbackDependencies": [] },
            { "id": "app-a", "root": "packages/app-a", "fallbackDependencies": ["core"] },
            { "id": "app-b", "root": "packages/app-b", "fallbackDependencies": ["core"] }
        ],
        "tasks": [
            {
                "id": "core:test",
                "project": "core",
                "kind": "test",
                "execution": { "executable": "true" },
                "dependsOn": [],
                "impact": { "mode": "reachability" }
            },
            {
                "id": "app-a:test",
                "project": "app-a",
                "kind": "test",
                "execution": { "executable": "true" },
                "dependsOn": [],
                "impact": { "mode": "reachability" }
            },
            {
                "id": "app-b:test",
                "project": "app-b",
                "kind": "test",
                "execution": { "executable": "true" },
                "dependsOn": [],
                "impact": { "mode": "reachability" }
            }
        ]
    })
    .to_string()
}

fn make_import(
    resolved: &str,
    kind: ImportKind,
    reexport_all: bool,
    span: (u32, u32),
) -> ImportFact {
    ImportFact {
        specifier: resolved.to_owned(),
        span: SourceSpan {
            start: span.0,
            end: span.1,
        },
        kind,
        type_only: false,
        requested_symbols: BTreeSet::new(),
        namespace_import: false,
        reexport_all,
        reexport_namespace: None,
        resolved_path: Some(resolved.to_owned()),
        position: None,
        export_deps: None,
        member_reads: None,
    }
}

fn make_symbol(name: &str, span: (u32, u32)) -> SymbolFact {
    SymbolFact {
        name: name.to_owned(),
        span: SourceSpan {
            start: span.0,
            end: span.1,
        },
    }
}

fn sample_graph() -> DependencyGraph {
    // core/src/leaf.ts <- core/src/index.ts (barrel) <- app-a/src/a.ts <- app-a/src/a.test.ts
    //                                                <- app-b/src/b.ts
    // core/src/helper.ts <- app-a/src/a.ts
    let modules = vec![
        ModuleNode {
            path: "packages/core/src/leaf.ts".into(),
            language: "typescript".into(),
            declarations: vec![make_symbol("leaf", (0, 30))],
            references: Vec::new(),
            imports: Vec::new(),
        },
        ModuleNode {
            path: "packages/core/src/index.ts".into(),
            language: "typescript".into(),
            declarations: Vec::new(),
            references: Vec::new(),
            imports: vec![make_import(
                "packages/core/src/leaf.ts",
                ImportKind::ReExport,
                true,
                (14, 24),
            )],
        },
        ModuleNode {
            path: "packages/core/src/helper.ts".into(),
            language: "typescript".into(),
            declarations: vec![make_symbol("helper", (0, 30))],
            references: Vec::new(),
            imports: Vec::new(),
        },
        ModuleNode {
            path: "packages/app-a/src/a.ts".into(),
            language: "typescript".into(),
            declarations: vec![make_symbol("runA", (0, 30))],
            references: Vec::new(),
            imports: vec![
                make_import(
                    "packages/core/src/index.ts",
                    ImportKind::Static,
                    false,
                    (0, 10),
                ),
                make_import(
                    "packages/core/src/helper.ts",
                    ImportKind::Static,
                    false,
                    (12, 22),
                ),
            ],
        },
        ModuleNode {
            path: "packages/app-a/src/a.test.ts".into(),
            language: "typescript".into(),
            declarations: Vec::new(),
            references: Vec::new(),
            imports: vec![make_import(
                "packages/app-a/src/a.ts",
                ImportKind::Static,
                false,
                (0, 10),
            )],
        },
        ModuleNode {
            path: "packages/app-b/src/b.ts".into(),
            language: "typescript".into(),
            declarations: vec![make_symbol("runB", (0, 30))],
            references: Vec::new(),
            imports: vec![make_import(
                "packages/core/src/index.ts",
                ImportKind::Static,
                false,
                (0, 10),
            )],
        },
    ];
    DependencyGraph::new(modules, Vec::new())
}

#[test]
fn ranks_files_and_projects_by_reverse_blast_radius() {
    let dir = TempDir::new("rank");
    dir.write("dads.testing.json", &manifest_json());
    dir.write("packages/core/src/leaf.ts", "");
    dir.write("packages/app-a/src/a.ts", "");
    dir.write("packages/app-b/src/b.ts", "");

    let response = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Hotspots,
            workspace_root: dir.0.to_string_lossy().into_owned(),
            ..NativeRequest::default()
        },
        Some(sample_graph()),
    );

    assert!(response.ok, "{:?}", response.error);
    let hotspots = response.result.unwrap().hotspots.unwrap();
    assert_eq!(hotspots.summary.total_files, 5);
    assert_eq!(hotspots.summary.total_barrels, 1);
    assert_eq!(hotspots.summary.total_projects, 3);
    assert_eq!(hotspots.summary.limit, 25);
    assert_eq!(hotspots.summary.min_projects, 1);
    assert!(!hotspots.summary.barrels_only);

    // leaf.ts reaches: leaf.ts, index.ts, a.ts, a.test.ts, b.ts => 5 files, 3 projects, 1 direct importer
    assert_eq!(hotspots.files[0].path, "packages/core/src/leaf.ts");
    assert_eq!(hotspots.files[0].project.as_deref(), Some("core"));
    assert_eq!(hotspots.files[0].affected_projects, 3);
    assert_eq!(hotspots.files[0].affected_files, 5);
    assert_eq!(hotspots.files[0].direct_importers, 1);
    assert!(!hotspots.files[0].is_barrel);

    // index.ts reaches: index.ts, a.ts, a.test.ts, b.ts => 4 files, 3 projects, 2 direct importers, barrel
    assert_eq!(hotspots.files[1].path, "packages/core/src/index.ts");
    assert_eq!(hotspots.files[1].affected_projects, 3);
    assert_eq!(hotspots.files[1].affected_files, 4);
    assert_eq!(hotspots.files[1].direct_importers, 2);
    assert!(hotspots.files[1].is_barrel);

    // helper.ts reaches: helper.ts, a.ts, a.test.ts => 3 files, 2 projects, 1 direct importer
    assert_eq!(hotspots.files[2].path, "packages/core/src/helper.ts");
    assert_eq!(hotspots.files[2].affected_projects, 2);
    assert_eq!(hotspots.files[2].affected_files, 3);
    assert_eq!(hotspots.files[2].direct_importers, 1);

    // Top project is core: reaches 3 projects (core, app-a, app-b), 6 files total, 2 direct dependent projects
    assert_eq!(hotspots.projects[0].project, "core");
    assert_eq!(hotspots.projects[0].affected_projects, 3);
    assert_eq!(hotspots.projects[0].affected_files, 6);
    assert_eq!(hotspots.projects[0].direct_dependent_projects, 2);
    assert_eq!(hotspots.projects[0].file_count, 3);
    assert_eq!(hotspots.projects[0].barrel_count, 1);
}

#[test]
fn supports_limit_min_projects_and_barrels_only_filters() {
    let dir = TempDir::new("filters");
    dir.write("dads.testing.json", &manifest_json());
    dir.write("packages/core/src/leaf.ts", "");
    dir.write("packages/app-a/src/a.ts", "");
    dir.write("packages/app-b/src/b.ts", "");

    // barrelsOnly = true returns only index.ts
    let barrels_resp = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Hotspots,
            workspace_root: dir.0.to_string_lossy().into_owned(),
            hotspots: Some(HotspotsOptions {
                limit: Some(10),
                min_projects: Some(1),
                barrels_only: true,
            }),
            ..NativeRequest::default()
        },
        Some(sample_graph()),
    );
    let barrels = barrels_resp.result.unwrap().hotspots.unwrap();
    assert_eq!(barrels.files.len(), 1);
    assert_eq!(barrels.files[0].path, "packages/core/src/index.ts");
    assert!(barrels.files[0].is_barrel);
    assert!(barrels.summary.barrels_only);

    // min_projects = 2 excludes app-a/src/a.ts and app-b/src/b.ts
    let min_proj_resp = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Hotspots,
            workspace_root: dir.0.to_string_lossy().into_owned(),
            hotspots: Some(HotspotsOptions {
                limit: Some(2),
                min_projects: Some(2),
                barrels_only: false,
            }),
            ..NativeRequest::default()
        },
        Some(sample_graph()),
    );
    let limited = min_proj_resp.result.unwrap().hotspots.unwrap();
    assert_eq!(limited.files.len(), 2);
    assert_eq!(limited.files[0].path, "packages/core/src/leaf.ts");
    assert_eq!(limited.files[1].path, "packages/core/src/index.ts");
    assert_eq!(limited.projects.len(), 1);
    assert_eq!(limited.projects[0].project, "core");
}
