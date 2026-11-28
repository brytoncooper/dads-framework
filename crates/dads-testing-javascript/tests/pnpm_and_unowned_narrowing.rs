use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request_with_graph,
};
use dads_testing_javascript::analyze_request;
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(root: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let out = Command::new("git").current_dir(root).args(args).output()?;
    if !out.status.success() {
        return Err(format!(
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )
        .into());
    }
    Ok(())
}

fn fresh_repo(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let root = std::env::temp_dir().join(format!("dads-testing-js-{name}-{}", std::process::id()));
    let _ = remove_dir_all(&root);
    create_dir_all(&root)?;
    git(&root, &["init", "-q"])?;
    git(&root, &["config", "user.email", "test@example.com"])?;
    git(&root, &["config", "user.name", "Test"])?;
    Ok(root)
}

fn plan_request(root: &Path, base: Option<&str>) -> NativeRequest {
    NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: root.to_string_lossy().into_owned(),
        base: base.map(str::to_owned),
        ..NativeRequest::default()
    }
}

#[test]
fn node_builtins_and_local_dist_stubs_resolve_without_widening() -> Result<(), Box<dyn Error>> {
    let root = fresh_repo("node-builtins-dist-stubs")?;
    for dir in ["packages/core/src", "packages/other/src"] {
        create_dir_all(root.join(dir))?;
    }
    write(
        root.join("packages/core/package.json"),
        r#"{ "name": "@acme/core" }"#,
    )?;
    write(
        root.join("packages/core/internal.d.ts"),
        "export * from './dist/internal';\n",
    )?;
    write(
        root.join("packages/core/src/internal.ts"),
        "import fs from 'fs';\nimport http from 'http';\nexport const ok = Boolean(fs && http);\n",
    )?;
    write(
        root.join("packages/other/package.json"),
        r#"{ "name": "@acme/other" }"#,
    )?;
    write(
        root.join("packages/other/src/index.ts"),
        "export const version = 1;\n",
    )?;
    write(
        root.join("dads.testing.json"),
        r#"{
  "schemaVersion": 1,
  "workspace": {
    "root": ".",
    "fullFallback": { "taskIds": ["core:test", "other:test"] }
  },
  "projects": [
    { "id": "core", "root": "packages/core", "fallbackDependencies": [] },
    { "id": "other", "root": "packages/other", "fallbackDependencies": ["core"] }
  ],
  "tasks": [
    {
      "id": "core:test",
      "project": "core",
      "kind": "test",
      "execution": { "executable": "node", "args": ["-e", "process.exit(0)"] },
      "dependsOn": [],
      "impact": { "mode": "reachability", "paths": [] }
    },
    {
      "id": "other:test",
      "project": "other",
      "kind": "test",
      "execution": { "executable": "node", "args": ["-e", "process.exit(0)"] },
      "dependsOn": [],
      "impact": { "mode": "reachability", "paths": [] }
    }
  ]
}"#,
    )?;
    git(&root, &["add", "."])?;
    git(&root, &["commit", "-q", "-m", "initial"])?;

    write(
        root.join("packages/other/src/index.ts"),
        "export const version = 2;\n",
    )?;
    let req = plan_request(&root, None);
    let graph = analyze_request(&req).ok_or("expected dependency graph")?;
    assert!(
        graph
            .uncertainties()
            .iter()
            .all(|u| u.code != "unresolved-bare-module" && u.code != "unresolved-local-module"),
        "expected no unresolved uncertainties for Node builtins or ./dist/internal stub, got: {:?}",
        graph.uncertainties()
    );
    let plan = execute_request_with_graph(req, Some(graph))
        .result
        .ok_or("expected plan result")?
        .plan;
    assert_eq!(plan.tasks[0].decision, "skip-proven-unaffected");
    assert_eq!(plan.tasks[1].decision, "run");

    let _ = remove_dir_all(&root);
    Ok(())
}

fn pnpm_lock_fixture(sentry_ver: &str, undici_ver: &str) -> String {
    format!(
        r#"lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      typescript:
        specifier: 5.8.0
        version: 5.8.0

  packages/core:
    dependencies:
      undici:
        specifier: 6.0.0
        version: 6.0.0

  examples/app:
    dependencies:
      sentry-cli:
        specifier: {sentry_ver}
        version: {sentry_ver}

packages:

  typescript@5.8.0:
    resolution: {{integrity: sha512-ts}}

  undici@6.0.0:
    resolution: {{integrity: sha512-u6}}

  undici@{undici_ver}:
    resolution: {{integrity: sha512-u-{undici_ver}}}

  sentry-cli@{sentry_ver}:
    resolution: {{integrity: sha512-s-{sentry_ver}}}
    hasBin: true

snapshots:

  typescript@5.8.0: {{}}

  undici@6.0.0: {{}}

  undici@{undici_ver}: {{}}

  sentry-cli@{sentry_ver}:
    dependencies:
      undici: {undici_ver}
"#
    )
}

#[test]
fn pnpm_v9_exact_snapshot_bfs_isolates_example_dep_bumps() -> Result<(), Box<dyn Error>> {
    let root = fresh_repo("pnpm-v9-exact-snapshot")?;
    for dir in ["packages/core/src", "examples/app"] {
        create_dir_all(root.join(dir))?;
    }
    write(
        root.join("packages/core/package.json"),
        r#"{ "name": "@acme/core", "dependencies": { "undici": "6.0.0" } }"#,
    )?;
    write(
        root.join("packages/core/src/index.ts"),
        "import { fetch } from 'undici';\nexport const go = () => fetch;\n",
    )?;
    write(
        root.join("examples/app/package.json"),
        r#"{ "name": "example-app", "dependencies": { "sentry-cli": "1.0.0" } }"#,
    )?;
    write(root.join("pnpm-lock.yaml"), pnpm_lock_fixture("1.0.0", "8.0.0"))?;
    write(
        root.join("dads.testing.json"),
        r#"{
  "schemaVersion": 1,
  "workspace": {
    "root": ".",
    "fullFallback": { "taskIds": ["core:test"] }
  },
  "projects": [
    { "id": "core", "root": "packages/core", "fallbackDependencies": [] }
  ],
  "tasks": [
    {
      "id": "core:test",
      "project": "core",
      "kind": "test",
      "execution": { "executable": "node", "args": ["-e", "process.exit(0)"] },
      "dependsOn": [],
      "impact": { "mode": "reachability", "paths": [] }
    }
  ]
}"#,
    )?;
    git(&root, &["add", "."])?;
    git(&root, &["commit", "-q", "-m", "initial"])?;

    // Bump sentry-cli (hasBin: true) and its undici@8.0.0 -> 8.0.1 inside examples/app only.
    // packages/core uses undici@6.0.0 (unchanged), so core:test must NOT run.
    write(
        root.join("examples/app/package.json"),
        r#"{ "name": "example-app", "dependencies": { "sentry-cli": "1.0.1" } }"#,
    )?;
    write(root.join("pnpm-lock.yaml"), pnpm_lock_fixture("1.0.1", "8.0.1"))?;

    let req = plan_request(&root, Some("HEAD"));
    let graph = analyze_request(&req);
    let plan = execute_request_with_graph(req, graph)
        .result
        .ok_or("expected pnpm plan result")?
        .plan;
    assert_eq!(
        plan.tasks[0].decision, "skip-proven-unaffected",
        "packages/core on unchanged undici@6.0.0 must stay skipped: {:?} / issues={:?}",
        plan.tasks[0], plan.issues
    );

    let _ = remove_dir_all(&root);
    Ok(())
}
