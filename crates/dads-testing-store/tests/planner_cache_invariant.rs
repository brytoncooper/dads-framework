//! End-to-end Planner-Cache Invariant across every dependency and input channel:
//! Oxc direct import, Oxc transitive import (with empty `fallbackDependencies`), `impact.paths`
//! exact/dir/glob, `fallbackDependencies`, `tsconfig.base.json` / root `tsconfig*.json`,
//! `setupFiles`, and `sql_impact` (`migrationRoots` and `snapshotPatterns`).

mod support;

use dads_testing_core::NativeRequest;
use dads_testing_core::graph::{
    DependencyGraph, ImportFact, ImportKind, ModuleNode, SourceSpan, SymbolFact,
};
use serde_json::json;
use std::error::Error;
use std::fs;
use std::path::Path;
use support::{
    RecordingStore, TempDir, changed_evidence, commit_all, git, mod_node, run_cached, write_file,
};

struct MutationCase<'a> {
    label: &'a str,
    rel_path: &'a str,
    mutated: &'a str,
    evidence: Option<(&'a str, &'a str)>,
    check_plan_selects: bool,
}

fn setup_invariant_workspace(
    repo: &Path,
    counter_file: &Path,
) -> Result<Vec<ModuleNode>, Box<dyn Error>> {
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["app:test"] },
            "sql": {
                "migrationRoots": ["migrations/sql"],
                "objects": ["public.users"],
                "snapshotPatterns": [{ "prefix": "migrations/grants/", "suffix": ".txt" }]
            }
        },
        "projects": [
            { "id": "core", "root": "libs/core", "fallbackDependencies": [] },
            { "id": "mid", "root": "libs/mid", "fallbackDependencies": [] },
            { "id": "fb", "root": "libs/fb", "fallbackDependencies": [] },
            { "id": "migrations", "root": "migrations", "fallbackDependencies": [] },
            { "id": "tools", "root": "tools", "fallbackDependencies": [] },
            { "id": "app", "root": "apps/app", "fallbackDependencies": ["fb"] }
        ],
        "tasks": [{
            "id": "app:test",
            "project": "app",
            "kind": "test",
            "execution": {
                "executable": "sh",
                "args": ["-c", format!("printf x >> '{}'", counter_file.display())],
                "fileNarrowing": {
                    "suffixes": [".test.ts"],
                    "setupFiles": ["vitest.setup.ts"]
                }
            },
            "dependsOn": [],
            "impact": {
                "mode": "reachability",
                "paths": ["tools/exact.txt", "tools/dir", "tools/glob/*.cfg"]
            },
            "sqlImpact": { "tables": ["public.users"] }
        }]
    });
    for (rel, content) in [
        (
            "tsconfig.base.json",
            r#"{"compilerOptions":{"strict":true}}"#,
        ),
        (
            "tsconfig.custom.json",
            r#"{"extends":"./tsconfig.base.json"}"#,
        ),
        ("vitest.setup.ts", "export const setup = 1;\n"),
        ("libs/core/src/core.ts", "export const core = 1;\n"),
        ("libs/mid/src/mid.ts", "export const mid = 1;\n"),
        ("libs/fb/src/data.json", "{\"v\":1}\n"),
        ("apps/app/src/app.test.ts", "export const t = 1;\n"),
        ("tools/exact.txt", "exact-1\n"),
        ("tools/dir/nested.txt", "dir-1\n"),
        ("tools/glob/rule.cfg", "glob-1\n"),
        (
            "migrations/sql/001.sql",
            "CREATE TABLE public.users (id int);\n",
        ),
        (
            "migrations/grants/public.users.txt",
            "GRANT SELECT ON public.users;\n",
        ),
    ] {
        write_file(repo, rel, content)?;
    }
    write_file(
        repo,
        "dads.testing.json",
        &serde_json::to_string_pretty(&manifest)?,
    )?;
    git(repo, &["init", "-q"])?;
    commit_all(repo)?;
    Ok(vec![
        mod_node("vitest.setup.ts", &["setup"], &[]),
        mod_node("libs/core/src/core.ts", &["core"], &[]),
        mod_node("libs/mid/src/mid.ts", &["mid"], &["libs/core/src/core.ts"]),
        mod_node("apps/app/src/app.test.ts", &["t"], &["libs/mid/src/mid.ts"]),
    ])
}

fn invariant_cases() -> Vec<MutationCase<'static>> {
    vec![
        MutationCase {
            label: "oxc-direct-import",
            rel_path: "libs/mid/src/mid.ts",
            mutated: "export const mid = 2;\n",
            evidence: Some(("libs/mid/src/mid.ts", "mid")),
            check_plan_selects: true,
        },
        MutationCase {
            label: "oxc-transitive-import",
            rel_path: "libs/core/src/core.ts",
            mutated: "export const core = 2;\n",
            evidence: Some(("libs/core/src/core.ts", "core")),
            check_plan_selects: true,
        },
        MutationCase {
            label: "impact-path-exact",
            rel_path: "tools/exact.txt",
            mutated: "exact-2\n",
            evidence: None,
            check_plan_selects: true,
        },
        MutationCase {
            label: "impact-path-directory",
            rel_path: "tools/dir/nested.txt",
            mutated: "dir-2\n",
            evidence: None,
            check_plan_selects: true,
        },
        MutationCase {
            label: "impact-path-glob",
            rel_path: "tools/glob/rule.cfg",
            mutated: "glob-2\n",
            evidence: None,
            check_plan_selects: true,
        },
        MutationCase {
            label: "fallback-dependency",
            rel_path: "libs/fb/src/data.json",
            mutated: "{\"v\":2}\n",
            evidence: None,
            check_plan_selects: true,
        },
        MutationCase {
            label: "tsconfig-base",
            rel_path: "tsconfig.base.json",
            mutated: r#"{"compilerOptions":{"strict":false}}"#,
            evidence: None,
            check_plan_selects: true,
        },
        MutationCase {
            label: "setup-file",
            rel_path: "vitest.setup.ts",
            mutated: "export const setup = 2;\n",
            evidence: Some(("vitest.setup.ts", "setup")),
            check_plan_selects: true,
        },
        MutationCase {
            label: "sql-migration-root",
            rel_path: "migrations/sql/001.sql",
            mutated: "ALTER TABLE public.users ADD COLUMN name text;\n",
            evidence: None,
            check_plan_selects: true,
        },
        MutationCase {
            label: "sql-snapshot-pattern",
            rel_path: "migrations/grants/public.users.txt",
            mutated: "GRANT ALL ON public.users;\n",
            evidence: None,
            check_plan_selects: true,
        },
        MutationCase {
            label: "root-custom-tsconfig",
            rel_path: "tsconfig.custom.json",
            mutated: r#"{"extends":"./tsconfig.base.json","compilerOptions":{"noEmit":true}}"#,
            evidence: None,
            check_plan_selects: false,
        },
    ]
}

#[test]
fn planner_cache_invariant_holds_for_every_dependency_and_input_channel()
-> Result<(), Box<dyn Error>> {
    let repo = TempDir::new("invariant-all")?;
    let cache = TempDir::new("invariant-cache")?;
    let base_nodes = setup_invariant_workspace(&repo.0, &cache.0.join("exec.count"))?;
    let store_diff = RecordingStore::new(&cache.0.join("diff"));
    let store_explicit = RecordingStore::new(&cache.0.join("explicit"));
    let explicit_req = || NativeRequest {
        only: true,
        task_ids: vec!["app:test".into()],
        ..NativeRequest::default()
    };

    let (_, r0) = run_cached(
        &repo.0,
        explicit_req(),
        Some(DependencyGraph::new(base_nodes.clone(), Vec::new())),
        &store_explicit,
    )?;
    assert_eq!(r0.counts.cached, 0);
    let baseline_key = store_explicit
        .key_for("app:test")
        .ok_or("baseline key missing")?;
    let _ = run_cached(
        &repo.0,
        explicit_req(),
        Some(DependencyGraph::new(base_nodes.clone(), Vec::new())),
        &store_diff,
    )?;
    let (_, r0_hit) = run_cached(
        &repo.0,
        explicit_req(),
        Some(DependencyGraph::new(base_nodes.clone(), Vec::new())),
        &store_explicit,
    )?;
    assert_eq!(r0_hit.counts.cached, 1);

    for case in invariant_cases() {
        let original = fs::read_to_string(repo.0.join(case.rel_path))?;
        write_file(&repo.0, case.rel_path, case.mutated)?;
        let graph = match case.evidence {
            Some((path, sym)) => DependencyGraph::new(base_nodes.clone(), Vec::new())
                .with_changed_module_evidence(vec![changed_evidence(path, sym)]),
            None => DependencyGraph::new(base_nodes.clone(), Vec::new()),
        };
        if case.check_plan_selects {
            let (plan, run) = run_cached(
                &repo.0,
                NativeRequest {
                    base: Some("HEAD".into()),
                    ..NativeRequest::default()
                },
                Some(graph.clone()),
                &store_diff,
            )?;
            let decision = plan
                .tasks
                .iter()
                .find(|t| t.id == "app:test")
                .ok_or("missing app:test")?;
            assert_eq!(decision.decision, "run", "channel {}", case.label);
            assert_eq!(run.counts.cached, 0, "channel {}", case.label);
            if let Some(new_key) = store_diff.key_for("app:test") {
                assert_ne!(new_key, baseline_key, "channel {}", case.label);
            }
        }
        let (_, explicit_run) = run_cached(&repo.0, explicit_req(), Some(graph), &store_explicit)?;
        assert_eq!(explicit_run.counts.cached, 0, "channel {}", case.label);
        let mutated_key = store_explicit
            .key_for("app:test")
            .ok_or_else(|| format!("channel {}: expected cacheable key", case.label))?;
        assert_ne!(mutated_key, baseline_key, "channel {}", case.label);

        write_file(&repo.0, case.rel_path, &original)?;
        let (_, restored) = run_cached(
            &repo.0,
            explicit_req(),
            Some(DependencyGraph::new(base_nodes.clone(), Vec::new())),
            &store_explicit,
        )?;
        assert_eq!(restored.counts.cached, 1, "channel {}", case.label);
    }
    Ok(())
}

fn file_read_import(target: &str) -> ImportFact {
    ImportFact {
        specifier: format!("fs:{target}"),
        span: SourceSpan { start: 0, end: 1 },
        kind: ImportKind::FileRead,
        type_only: false,
        requested_symbols: std::collections::BTreeSet::new(),
        namespace_import: false,
        reexport_all: false,
        reexport_namespace: None,
        resolved_path: Some(target.to_owned()),
        position: None,
        export_deps: None,
        member_reads: None,
    }
}

fn setup_file_read_invariant_workspace(
    repo: &Path,
    counter_file: &Path,
) -> Result<Vec<ModuleNode>, Box<dyn Error>> {
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["reader:test"] }
        },
        "projects": [
            { "id": "dep", "root": "libs/dep", "fallbackDependencies": [] },
            { "id": "target", "root": "libs/target", "fallbackDependencies": [] },
            { "id": "reader", "root": "apps/reader", "fallbackDependencies": [] }
        ],
        "tasks": [{
            "id": "reader:test",
            "project": "reader",
            "kind": "test",
            "execution": {
                "executable": "sh",
                "args": ["-c", format!("printf x >> '{}'", counter_file.display())]
            },
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        }]
    });
    for (rel, content) in [
        ("libs/dep/src/dep.ts", "export const dep = 1;\n"),
        (
            "libs/target/src/entry.ts",
            "import { dep } from '../../dep/src/dep';\nexport const entry = dep;\n",
        ),
        (
            "libs/target/src/unrelated.ts",
            "export const unrelated = 1;\n",
        ),
        ("libs/target/dir/item.txt", "item-1\n"),
        ("apps/reader/src/reader.test.ts", "export const t = 1;\n"),
    ] {
        write_file(repo, rel, content)?;
    }
    write_file(
        repo,
        "dads.testing.json",
        &serde_json::to_string_pretty(&manifest)?,
    )?;
    git(repo, &["init", "-q"])?;
    commit_all(repo)?;

    let mut reader = mod_node("apps/reader/src/reader.test.ts", &["t"], &[]);
    reader
        .imports
        .push(file_read_import("libs/target/src/entry.ts"));
    reader.imports.push(file_read_import("libs/target/dir/"));
    let dir_asset = ModuleNode {
        path: "libs/target/dir/".into(),
        language: "asset".into(),
        declarations: vec![SymbolFact {
            name: "__asset__".into(),
            span: SourceSpan { start: 0, end: 0 },
        }],
        references: Vec::new(),
        imports: Vec::new(),
    };
    Ok(vec![
        mod_node("libs/dep/src/dep.ts", &["dep"], &[]),
        mod_node(
            "libs/target/src/entry.ts",
            &["entry"],
            &["libs/dep/src/dep.ts"],
        ),
        mod_node("libs/target/src/unrelated.ts", &["unrelated"], &[]),
        dir_asset,
        reader,
    ])
}

fn assert_file_read_mutation_selects_and_misses(
    repo: &Path,
    nodes: &[ModuleNode],
    store: &RecordingStore,
    baseline_key: &str,
    rel_path: &str,
    mutated: &str,
    evidence: Option<(&str, &str)>,
) -> Result<(), Box<dyn Error>> {
    let original = fs::read_to_string(repo.join(rel_path))?;
    write_file(repo, rel_path, mutated)?;
    let graph = match evidence {
        Some((p, s)) => DependencyGraph::new(nodes.to_vec(), Vec::new())
            .with_changed_module_evidence(vec![changed_evidence(p, s)]),
        None => DependencyGraph::new(nodes.to_vec(), Vec::new()),
    };
    let (plan, run) = run_cached(
        repo,
        NativeRequest {
            base: Some("HEAD".into()),
            ..NativeRequest::default()
        },
        Some(graph),
        store,
    )?;
    assert_eq!(plan.tasks[0].decision, "run", "path {rel_path}");
    assert_eq!(run.counts.cached, 0, "path {rel_path}");
    assert_ne!(
        store.key_for("reader:test").as_deref(),
        Some(baseline_key),
        "path {rel_path}"
    );
    write_file(repo, rel_path, &original)?;
    Ok(())
}

fn assert_unrelated_mutation_skips_and_hits(
    repo: &Path,
    nodes: &[ModuleNode],
    store: &RecordingStore,
    baseline_key: &str,
    rel_path: &str,
    mutated: &str,
    export: &str,
) -> Result<(), Box<dyn Error>> {
    let original = fs::read_to_string(repo.join(rel_path))?;
    write_file(repo, rel_path, mutated)?;
    let graph = DependencyGraph::new(nodes.to_vec(), Vec::new())
        .with_changed_module_evidence(vec![changed_evidence(rel_path, export)]);
    let (plan, _) = run_cached(
        repo,
        NativeRequest {
            base: Some("HEAD".into()),
            ..NativeRequest::default()
        },
        Some(graph.clone()),
        store,
    )?;
    assert_eq!(
        plan.tasks[0].decision, "skip-proven-unaffected",
        "path {rel_path}"
    );
    let (_, hit) = run_cached(
        repo,
        NativeRequest {
            only: true,
            task_ids: vec!["reader:test".into()],
            ..NativeRequest::default()
        },
        Some(graph),
        store,
    )?;
    assert_eq!(hit.counts.cached, 1, "path {rel_path}");
    assert_eq!(
        store.key_for("reader:test").as_deref(),
        Some(baseline_key),
        "path {rel_path}"
    );
    write_file(repo, rel_path, &original)?;
    Ok(())
}

#[test]
fn planner_cache_invariant_for_file_read_is_direct_and_never_transitive()
-> Result<(), Box<dyn Error>> {
    let repo = TempDir::new("invariant-file-read")?;
    let cache = TempDir::new("invariant-file-read-cache")?;
    let nodes = setup_file_read_invariant_workspace(&repo.0, &cache.0.join("exec.count"))?;
    let store = RecordingStore::new(&cache.0.join("store"));
    let explicit_req = || NativeRequest {
        only: true,
        task_ids: vec!["reader:test".into()],
        ..NativeRequest::default()
    };

    let (base_plan, base_run) = run_cached(
        &repo.0,
        explicit_req(),
        Some(DependencyGraph::new(nodes.clone(), Vec::new())),
        &store,
    )?;
    assert_eq!(base_run.counts.cached, 0);
    let baseline_key = store.key_for("reader:test").ok_or("missing baseline key")?;
    let cache_inputs = base_plan
        .tasks
        .iter()
        .find(|t| t.id == "reader:test")
        .and_then(|t| t.cache_inputs.as_ref())
        .ok_or("missing cache_inputs")?;
    assert!(cache_inputs.cacheable);
    assert_eq!(cache_inputs.project_roots, vec!["apps/reader"]);
    assert!(
        cache_inputs
            .extra_files
            .contains(&"libs/target/src/entry.ts".to_owned())
    );
    assert!(
        cache_inputs
            .impact_paths
            .contains(&"libs/target/dir".to_owned())
    );

    assert_file_read_mutation_selects_and_misses(
        &repo.0,
        &nodes,
        &store,
        &baseline_key,
        "libs/target/src/entry.ts",
        "import { dep } from '../../dep/src/dep';\nexport const entry = dep + 1;\n",
        Some(("libs/target/src/entry.ts", "entry")),
    )?;
    assert_unrelated_mutation_skips_and_hits(
        &repo.0,
        &nodes,
        &store,
        &baseline_key,
        "libs/dep/src/dep.ts",
        "export const dep = 99;\n",
        "dep",
    )?;
    assert_unrelated_mutation_skips_and_hits(
        &repo.0,
        &nodes,
        &store,
        &baseline_key,
        "libs/target/src/unrelated.ts",
        "export const unrelated = 2;\n",
        "unrelated",
    )?;
    assert_file_read_mutation_selects_and_misses(
        &repo.0,
        &nodes,
        &store,
        &baseline_key,
        "libs/target/dir/item.txt",
        "item-2\n",
        None,
    )?;

    let (_, hit_restored) = run_cached(
        &repo.0,
        explicit_req(),
        Some(DependencyGraph::new(nodes, Vec::new())),
        &store,
    )?;
    assert_eq!(hit_restored.counts.cached, 1);
    Ok(())
}
