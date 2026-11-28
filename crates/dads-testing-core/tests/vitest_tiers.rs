#![allow(clippy::unwrap_used, clippy::expect_used, clippy::too_many_lines)]

use dads_testing_core::graph::{ChangedModuleEvidence, DependencyGraph, ModuleNode};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request,
    execute_request_with_graph_and_receipts,
};
use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    assert!(status.success(), "git {args:?} failed");
    Ok(())
}

fn commit_all(dir: &Path) -> Result<(), Box<dyn Error>> {
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
            "init",
        ],
    )
}

fn build_graph(projects: &[&str]) -> DependencyGraph {
    let nodes = projects
        .iter()
        .map(|project| ModuleNode {
            path: format!("{project}/unit.test.ts"),
            language: "typescript".into(),
            declarations: Vec::new(),
            references: Vec::new(),
            imports: Vec::new(),
        })
        .collect();
    let evidence = projects
        .iter()
        .map(|project| ChangedModuleEvidence {
            path: format!("{project}/unit.test.ts"),
            changed_exports: BTreeSet::new(),
            every_hunk_is_attributed: true,
            semantic_change: true,
            type_only_change: false,
            module_eval_changed: false,
            changed_type_exports: None,
        })
        .collect();
    DependencyGraph::new(nodes, Vec::new()).with_changed_module_evidence(evidence)
}

#[test]
fn auto_vitest_narrowing_excludes_integration_when_config_uses_vitest_tier_without_sibling_target()
-> Result<(), Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!("dads-vitest-tier-nosib-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("packages/staff/src"))?;
    fs::write(
        dir.join("packages/staff/package.json"),
        r#"{ "name": "staff", "scripts": { "test": "vitest run" } }"#,
    )?;
    fs::write(
        dir.join("packages/staff/vitest.config.mts"),
        "const TIER_FILES = ['**/*.integration.test.ts'];\nconst INTEGRATION_TIER = process.env['VITEST_TIER'] === 'integration';\nexport default { test: { include: INTEGRATION_TIER ? TIER_FILES : ['src/**/*.test.ts'], exclude: INTEGRATION_TIER ? [] : TIER_FILES } };\n",
    )?;
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "workspace": {
                "root": ".",
                "discover": {
                    "projectFiles": ["packages/*/package.json"],
                    "targetTemplates": [{
                        "target": "test",
                        "kind": "test",
                        "when": { "hasTarget": "test" },
                        "execution": { "executable": "npx", "args": ["vitest"], "cwd": "{projectRoot}" },
                        "autoVitestNarrowing": true,
                        "impact": { "mode": "reachability" }
                    }]
                }
            }
        }))?,
    )?;
    git(&dir, &["init", "-q"])?;
    commit_all(&dir)?;

    let resp = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::ExpandManifest,
        workspace_root: dir.display().to_string(),
        ..NativeRequest::default()
    });
    assert!(resp.ok, "{resp:?}");
    let expanded = resp
        .result
        .ok_or("missing result")?
        .manifest
        .ok_or("missing manifest")?;
    let tasks = expanded["tasks"].as_array().ok_or("tasks array")?;
    let task = tasks
        .iter()
        .find(|t| t["id"] == "staff:test")
        .ok_or("missing staff:test")?;
    let excludes: Vec<&str> = task["execution"]["fileNarrowing"]["excludeSuffixes"]
        .as_array()
        .ok_or("excludeSuffixes array")?
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(
        excludes.contains(&".integration.test.ts"),
        "expected .integration.test.ts excluded, got {excludes:?}"
    );
    assert!(
        excludes.contains(&".e2e.test.ts"),
        "expected .e2e.test.ts excluded, got {excludes:?}"
    );

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn narrowed_execution_sets_explicit_files_env_and_unnarrowed_does_not() -> Result<(), Box<dyn Error>>
{
    let dir = std::env::temp_dir().join(format!("dads-explicit-files-env-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("a"))?;
    fs::write(dir.join("a/unit.test.ts"), "export const a = 1;\n")?;
    fs::write(
        dir.join("runner.mjs"),
        "import fs from 'node:fs'; fs.writeFileSync(process.env.OUT_FILE, process.env.DADS_TEST_EXPLICIT_FILES ?? 'UNSET');\n",
    )?;
    let narrow_out = dir.join("narrow.txt");
    let wide_out = dir.join("wide.txt");
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "workspace": { "root": ".", "fullFallback": { "taskIds": ["a:test"] } },
            "projects": [{ "id": "a", "root": "a" }],
            "tasks": [{
                "id": "a:test",
                "project": "a",
                "kind": "test",
                "execution": {
                    "executable": "node",
                    "args": ["runner.mjs"],
                    "env": { "OUT_FILE": narrow_out.display().to_string() },
                    "fileNarrowing": { "suffixes": [".test.ts"] }
                },
                "impact": { "mode": "reachability" },
                "cache": false
            }]
        }))?,
    )?;
    git(&dir, &["init", "-q"])?;
    commit_all(&dir)?;

    // Edit a/unit.test.ts so working-tree narrowed plan selects it
    fs::write(dir.join("a/unit.test.ts"), "export const a = 2;\n")?;
    let graph = build_graph(&["a"]);
    let narrow_resp = execute_request_with_graph_and_receipts(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: dir.display().to_string(),
            ..NativeRequest::default()
        },
        Some(graph),
        None,
    );
    assert!(narrow_resp.ok, "{narrow_resp:?}");
    assert_eq!(fs::read_to_string(&narrow_out)?, "1");

    // Un-narrowed (--all) run -> DADS_TEST_EXPLICIT_FILES is UNSET
    let wide_manifest = fs::read_to_string(dir.join("dads.testing.json"))?.replace(
        &narrow_out.display().to_string(),
        &wide_out.display().to_string(),
    );
    fs::write(dir.join("dads.testing.json"), wide_manifest)?;
    let wide_resp = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Run,
        workspace_root: dir.display().to_string(),
        all: true,
        ..NativeRequest::default()
    });
    assert!(wide_resp.ok, "{wide_resp:?}");
    assert_eq!(fs::read_to_string(&wide_out)?, "UNSET");

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
