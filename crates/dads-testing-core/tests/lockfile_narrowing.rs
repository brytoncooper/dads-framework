use dads_testing_core::graph::{DependencyGraph, ImportFact, ImportKind, ModuleNode, SourceSpan};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request_with_graph,
};
use serde_json::json;
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

fn make_lockfile_repo(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!(
        "dads-testing-lockfile-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("packages/alpha/src"))?;
    fs::create_dir_all(dir.join("packages/beta/src"))?;
    git(&dir, &["init", "-q"])?;

    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["alpha:test", "beta:test"] }
        },
        "projects": [
            { "id": "alpha", "root": "packages/alpha", "fallbackDependencies": [] },
            { "id": "beta", "root": "packages/beta", "fallbackDependencies": [] }
        ],
        "tasks": [
            {
                "id": "alpha:test",
                "project": "alpha",
                "kind": "test",
                "execution": { "executable": "true", "args": [] },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": ["package-lock.json"] }
            },
            {
                "id": "beta:test",
                "project": "beta",
                "kind": "test",
                "execution": { "executable": "true", "args": [] },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": ["package-lock.json"] }
            }
        ]
    });
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;

    let pkg = json!({
        "name": "lockfile-fixture",
        "version": "1.0.0",
        "dependencies": {
            "alpha-lib": "1.0.0",
            "beta-lib": "1.0.0"
        },
        "devDependencies": {
            "typescript": "5.8.0"
        }
    });
    fs::write(
        dir.join("package.json"),
        serde_json::to_string_pretty(&pkg)?,
    )?;

    let lock = json!({
        "name": "lockfile-fixture",
        "lockfileVersion": 3,
        "packages": {
            "": { "name": "lockfile-fixture" },
            "node_modules/alpha-lib": {
                "version": "1.0.0",
                "integrity": "sha512-alpha1",
                "dependencies": { "leaf-dep": "1.0.0" }
            },
            "node_modules/leaf-dep": {
                "version": "1.0.0",
                "integrity": "sha512-leaf1"
            },
            "node_modules/beta-lib": {
                "version": "1.0.0",
                "integrity": "sha512-beta1"
            },
            "node_modules/typescript": {
                "version": "5.8.0",
                "integrity": "sha512-ts1",
                "dev": true
            }
        }
    });
    fs::write(
        dir.join("package-lock.json"),
        serde_json::to_string_pretty(&lock)?,
    )?;

    fs::write(
        dir.join("packages/alpha/src/index.ts"),
        "import { a } from 'alpha-lib'; export const x = a;\n",
    )?;
    fs::write(
        dir.join("packages/beta/src/index.ts"),
        "import { b } from 'beta-lib'; export const y = b;\n",
    )?;

    git(&dir, &["add", "."])?;
    git(
        &dir,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e.invalid",
            "commit",
            "-qm",
            "base",
        ],
    )?;
    Ok(dir)
}

fn fixture_graph() -> DependencyGraph {
    let nodes = vec![
        ModuleNode {
            path: "packages/alpha/src/index.ts".to_owned(),
            language: "typescript".to_owned(),
            declarations: Vec::new(),
            references: Vec::new(),
            imports: vec![ImportFact {
                specifier: "alpha-lib".to_owned(),
                span: SourceSpan { start: 0, end: 10 },
                kind: ImportKind::Static,
                type_only: false,
                requested_symbols: BTreeSet::from(["a".to_owned()]),
                namespace_import: false,
                reexport_all: false,
                reexport_namespace: None,
                resolved_path: None,
                position: None,
                export_deps: None,
                member_reads: None,
            }],
        },
        ModuleNode {
            path: "packages/beta/src/index.ts".to_owned(),
            language: "typescript".to_owned(),
            declarations: Vec::new(),
            references: Vec::new(),
            imports: vec![ImportFact {
                specifier: "beta-lib".to_owned(),
                span: SourceSpan { start: 0, end: 10 },
                kind: ImportKind::Static,
                type_only: false,
                requested_symbols: BTreeSet::from(["b".to_owned()]),
                namespace_import: false,
                reexport_all: false,
                reexport_namespace: None,
                resolved_path: None,
                position: None,
                export_deps: None,
                member_reads: None,
            }],
        },
    ];
    DependencyGraph::new(nodes, Vec::new())
}

fn run_plan(dir: &Path) -> Result<Vec<String>, Box<dyn Error>> {
    let req = NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        manifest_path: None,
        base: Some("HEAD".to_owned()),
        head: None,
        all: false,
        task_ids: Vec::new(),
        task_kinds: Vec::new(),
        shard: None,
        jobs: None,
        cache: false,
        remote_cache_url: None,
        ..NativeRequest::default()
    };
    let resp = execute_request_with_graph(req, Some(fixture_graph()));
    assert!(resp.ok, "{resp:?}");
    let plan = resp.result.ok_or("missing result")?.plan;
    Ok(plan
        .tasks
        .into_iter()
        .filter(|t| t.decision == "run")
        .map(|t| t.id)
        .collect())
}

#[test]
fn adding_unused_dev_dependency_selects_zero_tasks() -> Result<(), Box<dyn Error>> {
    let dir = make_lockfile_repo("unused-new")?;

    let mut pkg: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.join("package.json"))?)?;
    pkg["devDependencies"]["@dads-framework/testing"] = json!("0.6.4");
    fs::write(
        dir.join("package.json"),
        serde_json::to_string_pretty(&pkg)?,
    )?;

    let mut lock: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.join("package-lock.json"))?)?;
    lock["packages"]["node_modules/@dads-framework/testing"] = json!({
        "version": "0.6.4",
        "integrity": "sha512-dads1",
        "dev": true,
        "bin": { "dad-test": "bin/dad-test.js" }
    });
    fs::write(
        dir.join("package-lock.json"),
        serde_json::to_string_pretty(&lock)?,
    )?;

    assert_eq!(run_plan(&dir)?, Vec::<String>::new());
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn upgrading_transitive_dependency_selects_only_importing_project() -> Result<(), Box<dyn Error>> {
    let dir = make_lockfile_repo("transitive-dep")?;

    let mut lock: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.join("package-lock.json"))?)?;
    lock["packages"]["node_modules/leaf-dep"]["version"] = json!("1.0.10");
    lock["packages"]["node_modules/leaf-dep"]["integrity"] = json!("sha512-leaf2000");
    fs::write(
        dir.join("package-lock.json"),
        serde_json::to_string_pretty(&lock)?,
    )?;

    assert_eq!(run_plan(&dir)?, vec!["alpha:test".to_owned()]);
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn upgrading_toolchain_package_widens_all_tasks() -> Result<(), Box<dyn Error>> {
    let dir = make_lockfile_repo("toolchain-widen")?;

    let mut lock: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.join("package-lock.json"))?)?;
    lock["packages"]["node_modules/typescript"]["version"] = json!("5.9.10");
    lock["packages"]["node_modules/typescript"]["integrity"] = json!("sha512-ts2000");
    fs::write(
        dir.join("package-lock.json"),
        serde_json::to_string_pretty(&lock)?,
    )?;

    assert_eq!(
        run_plan(&dir)?,
        vec!["alpha:test".to_owned(), "beta:test".to_owned()]
    );
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn editing_package_json_scripts_widens_all_tasks() -> Result<(), Box<dyn Error>> {
    let dir = make_lockfile_repo("scripts-widen")?;

    let mut pkg: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.join("package.json"))?)?;
    pkg["scripts"] = json!({ "test": "vitest run" });
    fs::write(
        dir.join("package.json"),
        serde_json::to_string_pretty(&pkg)?,
    )?;

    assert_eq!(
        run_plan(&dir)?,
        vec!["alpha:test".to_owned(), "beta:test".to_owned()]
    );
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
