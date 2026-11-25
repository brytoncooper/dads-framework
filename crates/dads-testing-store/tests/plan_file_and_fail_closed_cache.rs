//! End-to-end tests for `--plan-file` `cacheInputs` round-trip, fail-closed cacheability, and
//! non-git filesystem fallback with symlink fail-closed protection.

mod support;

use dads_testing_core::graph::{DependencyGraph, GraphUncertainty, GraphUncertaintyScope};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request_with_graph_and_receipts,
};
use serde_json::json;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use support::{
    RecordingStore, TempDir, changed_evidence, commit_all, git, mod_node, run_cached, write_file,
};

fn setup_plan_file_repo(repo: &Path, counter: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": { "root": ".", "fullFallback": { "taskIds": ["table:test", "web:test"] } },
        "projects": [
            { "id": "table", "root": "libs/table", "fallbackDependencies": [] },
            { "id": "web", "root": "apps/web", "fallbackDependencies": [] },
            { "id": "tools", "root": "tools", "fallbackDependencies": [] }
        ],
        "tasks": [
            { "id": "table:test", "project": "table", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability", "paths": [] } },
            { "id": "web:test", "project": "web", "kind": "test", "execution": { "executable": "sh", "args": ["-c", format!("printf x >> '{}'", counter.display())] }, "dependsOn": [], "impact": { "mode": "reachability", "paths": ["tools/config.json"] } }
        ]
    });
    write_file(repo, "libs/table/src/table.ts", "export const col = 1;\n")?;
    write_file(repo, "apps/web/src/page.ts", "export const page = 1;\n")?;
    write_file(repo, "tools/config.json", "{\"v\":1}\n")?;
    write_file(
        repo,
        "dads.testing.json",
        &serde_json::to_string_pretty(&manifest)?,
    )?;
    git(repo, &["init", "-q"])?;
    commit_all(repo)?;

    write_file(repo, "libs/table/src/table.ts", "export const col = 2;\n")?;
    let graph = DependencyGraph::new(
        vec![
            mod_node("libs/table/src/table.ts", &["col"], &[]),
            mod_node(
                "apps/web/src/page.ts",
                &["page"],
                &["libs/table/src/table.ts"],
            ),
        ],
        Vec::new(),
    )
    .with_changed_module_evidence(vec![changed_evidence("libs/table/src/table.ts", "col")]);

    let planned = execute_request_with_graph_and_receipts(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Plan,
            workspace_root: repo.to_string_lossy().into_owned(),
            base: Some("HEAD".into()),
            ..NativeRequest::default()
        },
        Some(graph),
        None,
    );
    assert!(planned.ok, "{planned:?}");
    let plan = planned.result.ok_or("missing plan")?.plan;
    let plan_file = repo.join(".git/ci-plan.json");
    let plan_json = serde_json::to_string_pretty(&plan)?;
    assert!(plan_json.contains("\"cacheInputs\""));
    fs::write(&plan_file, &plan_json)?;
    Ok(plan_file)
}

#[test]
fn plan_file_round_trip_preserves_cache_inputs_and_invalidates_on_oxc_or_impact_edits()
-> Result<(), Box<dyn Error>> {
    let repo = TempDir::new("plan-file-cache")?;
    let cache = TempDir::new("plan-file-store")?;
    let counter = cache.0.join("runs.log");
    let plan_file = setup_plan_file_repo(&repo.0, &counter)?;
    let store = RecordingStore::new(&cache.0);
    let plan_req = || NativeRequest {
        plan_file: Some(plan_file.display().to_string()),
        projects: vec!["web".into()],
        ..NativeRequest::default()
    };

    let (_, r1) = run_cached(&repo.0, plan_req(), None, &store)?;
    assert_eq!(r1.counts.cached, 0);
    assert_eq!(fs::read_to_string(&counter)?.len(), 1);
    let key1 = store.key_for("web:test").ok_or("missing web:test key")?;

    let (_, r2) = run_cached(&repo.0, plan_req(), None, &store)?;
    assert_eq!(r2.counts.cached, 1);
    assert_eq!(fs::read_to_string(&counter)?.len(), 1);

    write_file(
        &repo.0,
        "libs/table/src/table.ts",
        "export const col = 3;\n",
    )?;
    let (_, r3) = run_cached(&repo.0, plan_req(), None, &store)?;
    assert_eq!(r3.counts.cached, 0);
    assert_eq!(fs::read_to_string(&counter)?.len(), 2);
    let key3 = store.key_for("web:test").ok_or("missing key3")?;
    assert_ne!(key3, key1);

    write_file(&repo.0, "tools/config.json", "{\"v\":2}\n")?;
    let (_, r4) = run_cached(&repo.0, plan_req(), None, &store)?;
    assert_eq!(r4.counts.cached, 0);
    assert_eq!(fs::read_to_string(&counter)?.len(), 3);
    assert_ne!(store.key_for("web:test").ok_or("missing key4")?, key3);

    // Legacy plan file without `cacheInputs` fails closed (never caches).
    let legacy_file = cache.0.join("legacy-plan.json");
    fs::write(
        &legacy_file,
        serde_json::to_string(&json!({
            "schemaVersion": 1,
            "scope": { "kind": "working-tree", "changedPaths": [], "fullFallback": false },
            "tasks": [{
                "id": "web:test",
                "decision": "run",
                "reason": "graph-symbol-importer",
                "confidence": "graph-symbol-derived",
                "widened": false,
                "project": "web"
            }],
            "issues": [],
            "complete": true,
            "counts": { "run": 1, "skipProvenUnaffected": 0 }
        }))?,
    )?;
    let legacy_req = || NativeRequest {
        plan_file: Some(legacy_file.display().to_string()),
        ..NativeRequest::default()
    };
    let (_, leg1) = run_cached(&repo.0, legacy_req(), None, &store)?;
    assert_eq!(leg1.counts.cached, 0);
    assert!(!store.was_key_requested("web:test"));
    let (_, leg2) = run_cached(&repo.0, legacy_req(), None, &store)?;
    assert_eq!(leg2.counts.cached, 0);
    Ok(())
}

#[test]
fn fail_closed_cacheability_blocks_always_fallback_missing_graph_and_unscoped_dynamic_import()
-> Result<(), Box<dyn Error>> {
    let repo = TempDir::new("fail-closed-run")?;
    let cache = TempDir::new("fail-closed-cache")?;
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": { "root": ".", "fullFallback": { "taskIds": ["always:t", "dyn:t", "ok:t"] } },
        "projects": [
            { "id": "always", "root": "always", "fallbackDependencies": [] },
            { "id": "dyn", "root": "dyn", "fallbackDependencies": [] },
            { "id": "ok", "root": "ok", "fallbackDependencies": [] }
        ],
        "tasks": [
            { "id": "always:t", "project": "always", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "always" } },
            { "id": "dyn:t", "project": "dyn", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
            { "id": "ok:t", "project": "ok", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
        ]
    });
    write_file(&repo.0, "always/a.ts", "export const a = 1;\n")?;
    write_file(&repo.0, "dyn/d.ts", "export const d = 1;\n")?;
    write_file(&repo.0, "ok/o.ts", "export const o = 1;\n")?;
    write_file(
        &repo.0,
        "dads.testing.json",
        &serde_json::to_string_pretty(&manifest)?,
    )?;
    git(&repo.0, &["init", "-q"])?;
    commit_all(&repo.0)?;

    let store = RecordingStore::new(&cache.0);
    let graph = DependencyGraph::new(
        vec![
            mod_node("always/a.ts", &["a"], &[]),
            mod_node("dyn/d.ts", &["d"], &[]),
            mod_node("ok/o.ts", &["o"], &[]),
        ],
        vec![GraphUncertainty {
            path: "dyn/d.ts".into(),
            code: "nonliteral-dynamic-import".into(),
            message: "dynamic import".into(),
            scope: GraphUncertaintyScope::WholeWorkspace,
            location: None,
        }],
    );

    for round in 0..2 {
        let (_, run) = run_cached(
            &repo.0,
            NativeRequest {
                only: true,
                task_ids: vec!["always:t".into(), "dyn:t".into(), "ok:t".into()],
                ..NativeRequest::default()
            },
            Some(graph.clone()),
            &store,
        )?;
        assert_eq!(run.counts.cached, if round == 0 { 0 } else { 1 });
        assert!(store.key_for("always:t").is_none());
        assert!(store.key_for("dyn:t").is_none());
        assert!(store.key_for("ok:t").is_some());
    }
    for _ in 0..2 {
        let (_, run) = run_cached(
            &repo.0,
            NativeRequest {
                only: true,
                task_ids: vec!["ok:t".into()],
                ..NativeRequest::default()
            },
            None,
            &store,
        )?;
        assert_eq!(run.counts.cached, 0);
        assert!(store.key_for("ok:t").is_none());
    }
    for _ in 0..2 {
        let (_, run) = run_cached(
            &repo.0,
            NativeRequest {
                all: true,
                ..NativeRequest::default()
            },
            Some(graph.clone()),
            &store,
        )?;
        assert_eq!(run.counts.cached, 0);
    }
    Ok(())
}

#[test]
fn non_git_filesystem_fallback_hashes_impact_paths_and_fails_closed_on_symlinks()
-> Result<(), Box<dyn Error>> {
    let non_git = TempDir::new("non-git-fs-fallback")?;
    let non_git_cache = TempDir::new("non-git-cache")?;
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": { "root": ".", "fullFallback": { "taskIds": ["app:test"] } },
        "projects": [{ "id": "app", "root": "app", "fallbackDependencies": [] }],
        "tasks": [{
            "id": "app:test",
            "project": "app",
            "kind": "test",
            "execution": { "executable": "true" },
            "dependsOn": [],
            "impact": {
                "mode": "changed-files",
                "paths": ["cfg/exact.txt", "cfg/dir", "cfg/glob/*.rule"]
            }
        }]
    });
    write_file(&non_git.0, "app/index.ts", "export const x = 1;\n")?;
    write_file(&non_git.0, "cfg/exact.txt", "1\n")?;
    write_file(&non_git.0, "cfg/dir/a.txt", "1\n")?;
    write_file(&non_git.0, "cfg/glob/one.rule", "1\n")?;
    write_file(
        &non_git.0,
        "dads.testing.json",
        &serde_json::to_string_pretty(&manifest)?,
    )?;

    let fs_store = RecordingStore::new(&non_git_cache.0);
    let ng_req = || NativeRequest {
        only: true,
        task_ids: vec!["app:test".into()],
        ..NativeRequest::default()
    };
    let (_, ng1) = run_cached(&non_git.0, ng_req(), None, &fs_store)?;
    assert_eq!(ng1.counts.cached, 0);
    let k_base = fs_store.key_for("app:test").ok_or("missing non-git key")?;
    let (_, ng2) = run_cached(&non_git.0, ng_req(), None, &fs_store)?;
    assert_eq!(ng2.counts.cached, 1);

    for rel in ["cfg/exact.txt", "cfg/dir/a.txt", "cfg/glob/one.rule"] {
        write_file(&non_git.0, rel, "2\n")?;
        let (_, r) = run_cached(&non_git.0, ng_req(), None, &fs_store)?;
        assert_eq!(r.counts.cached, 0, "non-git mutation of {rel} must miss");
        assert_ne!(
            fs_store.key_for("app:test").as_deref(),
            Some(k_base.as_str())
        );
        write_file(&non_git.0, rel, "1\n")?;
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            non_git.0.join("cfg/exact.txt"),
            non_git.0.join("cfg/dir/link.txt"),
        )?;
        let (_, r_sym) = run_cached(&non_git.0, ng_req(), None, &fs_store)?;
        assert_eq!(r_sym.counts.cached, 0);
        assert!(
            fs_store.key_for("app:test").is_none(),
            "symlink inside impact_paths must fail closed"
        );
    }
    Ok(())
}
