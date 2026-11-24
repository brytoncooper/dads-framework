use dads_testing_core::{NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    assert!(status.success(), "git {args:?} failed");
    Ok(())
}

fn make_declarative_repo(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!(
        "dads-testing-discover-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("libs/alpha/src"))?;
    fs::create_dir_all(dir.join("libs/beta/src"))?;
    fs::create_dir_all(dir.join("apps/web/src"))?;
    fs::create_dir_all(dir.join("scripts"))?;
    git(&dir, &["init", "-q"])?;

    fs::write(
        dir.join("libs/alpha/project.json"),
        r#"{ "name": "alpha", "tags": ["scope:lib"], "targets": { "lint": {}, "lint-typed": {}, "test": {} } }"#,
    )?;
    fs::write(
        dir.join("libs/alpha/vitest.config.mts"),
        "export default {};\n",
    )?;
    fs::write(
        dir.join("libs/alpha/src/a.test.ts"),
        "export const t = 1;\n",
    )?;

    fs::write(
        dir.join("libs/beta/project.json"),
        r#"{ "name": "beta", "tags": ["scope:lib", "tier:db"], "targets": { "lint": {}, "test:integration": {} } }"#,
    )?;
    fs::write(
        dir.join("libs/beta/vitest.config.mts"),
        "export default {};\n",
    )?;
    fs::write(dir.join("libs/beta/src/b.test.ts"), "export const t = 2;\n")?;

    fs::write(
        dir.join("apps/web/project.json"),
        r#"{ "name": "web", "tags": ["scope:app"], "targets": { "lint": {}, "build": {} } }"#,
    )?;
    fs::write(dir.join("apps/web/src/main.ts"), "export const w = 3;\n")?;

    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "nonCodeSuffixes": [".md"],
            "discover": {
                "projectFiles": ["libs/**/project.json", "apps/**/project.json"],
                "namedImpacts": {
                    "oxlint": [".oxlintrc.json", "tsconfig.base.json"],
                    "dbMigrations": ["apps/api/migrations/*.sql"]
                },
                "targetTemplates": [
                    {
                        "target": "lint",
                        "kind": "lint",
                        "when": { "hasTarget": "lint" },
                        "execution": {
                            "executable": "oxlint",
                            "args": ["-c", ".oxlintrc.json", "{projectRoot}"],
                            "batch": { "maxSize": 64, "groupKey": "oxlint", "sharedArgs": 2 }
                        },
                        "dependsOn": ["{project}:lint-typed"],
                        "dependsOnIfExists": true,
                        "impact": { "mode": "reachability", "named": ["oxlint"], "paths": [] }
                    },
                    {
                        "target": "lint-typed",
                        "kind": "lint",
                        "when": { "hasTarget": "lint-typed" },
                        "execution": {
                            "executable": "node",
                            "args": ["scripts/lint-typed.mjs", "{projectRoot}"]
                        },
                        "impact": { "mode": "reachability", "named": ["oxlint"], "paths": [] }
                    },
                    {
                        "target": "test",
                        "kind": "test",
                        "when": { "fileExists": ["vitest.config.mts"], "hasTarget": "test" },
                        "execution": {
                            "executable": "vitest",
                            "args": ["run", "--root", "{projectRoot}"],
                            "fileNarrowing": {
                                "suffixes": [".test.ts"],
                                "setupFiles": ["{projectRoot}/vitest.config.mts"]
                            }
                        },
                        "impact": { "mode": "reachability", "paths": ["{projectRoot}/vitest.config.mts"] }
                    },
                    {
                        "target": "test:integration",
                        "kind": "test",
                        "when": { "hasTarget": "test:integration" },
                        "execution": {
                            "executable": "vitest",
                            "args": ["run", "--root", "{projectRoot}"],
                            "env": { "VITEST_TIER": "integration" },
                            "fileNarrowing": { "suffixes": [".test.ts"] }
                        },
                        "impact": { "mode": "reachability", "paths": ["{projectRoot}/vitest.config.mts"] }
                    }
                ],
                "taskOverrides": [
                    {
                        "target": "test:integration",
                        "when": { "hasTag": "tier:db" },
                        "addNamedImpacts": ["dbMigrations"]
                    }
                ]
            }
        },
        "projects": [
            { "id": "scripts", "root": "scripts", "fallbackDependencies": [] }
        ],
        "tasks": [
            {
                "id": "scripts:lint-walls",
                "project": "scripts",
                "kind": "lint",
                "execution": { "executable": "node", "args": ["scripts/lint-walls.mjs"] },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": ["eslint.config.mjs"] }
            }
        ]
    });
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&manifest)?,
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
            "init",
        ],
    )?;
    Ok(dir)
}

#[test]
fn expand_manifest_produces_canonical_ir_preserving_file_narrowing_and_optional_deps()
-> Result<(), Box<dyn Error>> {
    let dir = make_declarative_repo("expand")?;
    let resp = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::ExpandManifest,
        workspace_root: dir.display().to_string(),
        ..NativeRequest::default()
    });
    assert!(resp.ok, "{resp:?}");
    let expanded = resp
        .result
        .and_then(|r| r.manifest)
        .ok_or("missing expanded manifest")?;

    // Workspace discover block is stripped in the canonical expanded IR, and fullFallback is populated.
    assert!(expanded["workspace"].get("discover").is_none());
    let projects = expanded["projects"].as_array().ok_or("projects array")?;
    assert_eq!(projects.len(), 4);

    let tasks = expanded["tasks"].as_array().ok_or("tasks array")?;
    let find_task = |id: &str| tasks.iter().find(|t| t["id"].as_str() == Some(id));

    // alpha:lint depends on alpha:lint-typed (exists); beta:lint has dependsOn [] (pruned!).
    let alpha_lint = find_task("alpha:lint").ok_or("alpha:lint")?;
    assert_eq!(
        alpha_lint["dependsOn"],
        serde_json::json!(["alpha:lint-typed"])
    );
    assert_eq!(alpha_lint["execution"]["batch"]["maxSize"], 64);

    let beta_lint = find_task("beta:lint").ok_or("beta:lint")?;
    assert_eq!(beta_lint["dependsOn"], serde_json::json!([]));

    // alpha:test preserves fileNarrowing with expanded setupFiles!
    let alpha_test = find_task("alpha:test").ok_or("alpha:test")?;
    assert_eq!(
        alpha_test["execution"]["fileNarrowing"]["setupFiles"],
        serde_json::json!(["libs/alpha/vitest.config.mts"])
    );

    // beta:test:integration received dbMigrations via taskOverrides + hasTag!
    let beta_int = find_task("beta:test:integration").ok_or("beta:test:integration")?;
    let impact_paths = beta_int["impact"]["paths"]
        .as_array()
        .ok_or("impact paths")?;
    assert!(
        impact_paths
            .iter()
            .any(|v| v.as_str() == Some("apps/api/migrations/*.sql"))
    );

    // Explicit task scripts:lint-walls merged cleanly.
    assert!(find_task("scripts:lint-walls").is_some());

    // Planning directly against the declarative manifest works identically!
    let plan_resp = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        all: true,
        ..NativeRequest::default()
    });
    assert!(plan_resp.ok, "{plan_resp:?}");
    let plan = plan_resp.result.ok_or("plan result")?.plan;
    assert_eq!(plan.counts.run, tasks.len());

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
