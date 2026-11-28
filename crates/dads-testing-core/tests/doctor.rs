use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request,
};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn temp_ws(label: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!(
        "dads-doctor-{label}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn git_init_commit(dir: &Path) -> Result<(), Box<dyn Error>> {
    for args in [
        &["init", "-q"][..],
        &["add", "."][..],
        &["-c", "user.name=T", "-c", "user.email=t@e.invalid", "commit", "-qm", "init"][..],
    ] {
        let status = Command::new("git").args(args).current_dir(dir).status()?;
        assert!(status.success(), "git {args:?} failed");
    }
    Ok(())
}

#[test]
fn doctor_passes_clean_dual_tier_workspace() -> Result<(), Box<dyn Error>> {
    let dir = temp_ws("clean")?;
    fs::create_dir_all(dir.join("libs/sync/src"))?;
    fs::write(dir.join("libs/sync/src/unit.test.ts"), "export const x = 1;\n")?;
    fs::write(dir.join("libs/sync/src/db.integration.test.ts"), "export const y = 2;\n")?;
    fs::write(
        dir.join("libs/sync/vitest.config.mts"),
        "const INTEGRATION = process.env['VITEST_TIER'] === 'integration';\nexport default { test: { include: INTEGRATION ? ['**/*.integration.test.ts'] : ['src/**/*.test.ts'], exclude: INTEGRATION ? [] : ['**/*.integration.test.ts'] } };\n",
    )?;
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "workspace": {
                "root": ".",
                "fullFallback": { "taskIds": ["sync:test", "sync:test:integration"] }
            },
            "projects": [{ "id": "sync", "root": "libs/sync" }],
            "tasks": [
                {
                    "id": "sync:test",
                    "project": "sync",
                    "kind": "test",
                    "execution": {
                        "executable": "vitest",
                        "args": ["run", "--root", "libs/sync"],
                        "fileNarrowing": {
                            "suffixes": [".test.ts"],
                            "excludeSuffixes": [".integration.test.ts", ".e2e.test.ts"]
                        }
                    },
                    "impact": { "mode": "reachability" }
                },
                {
                    "id": "sync:test:integration",
                    "project": "sync",
                    "kind": "test",
                    "execution": {
                        "executable": "vitest",
                        "args": ["run", "--root", "libs/sync"],
                        "env": { "VITEST_TIER": "integration" },
                        "fileNarrowing": {
                            "suffixes": [".integration.test.ts", ".e2e.test.ts"]
                        }
                    },
                    "impact": { "mode": "reachability" }
                }
            ]
        }))?,
    )?;
    git_init_commit(&dir)?;

    let resp = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Doctor,
        workspace_root: dir.display().to_string(),
        ..NativeRequest::default()
    });
    assert!(resp.ok, "{resp:?}");
    let doc = resp.result.ok_or("missing result")?.doctor.ok_or("missing doctor")?;
    assert!(doc.ok, "expected clean doctor, got findings: {:?}", doc.findings);
    assert_eq!(doc.counts.test_files_checked, 2);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn doctor_catches_vitest_tier_missing_integration_target_and_unowned_integration_file()
-> Result<(), Box<dyn Error>> {
    let dir = temp_ws("missing-integ")?;
    fs::create_dir_all(dir.join("libs/staff/src"))?;
    fs::write(dir.join("libs/staff/src/unit.test.ts"), "export const x = 1;\n")?;
    fs::write(dir.join("libs/staff/src/filters.integration.test.ts"), "export const y = 2;\n")?;
    fs::write(
        dir.join("libs/staff/vitest.config.mts"),
        "const INTEGRATION = process.env['VITEST_TIER'] === 'integration';\nexport default { test: { include: INTEGRATION ? ['**/*.integration.test.ts'] : ['src/**/*.test.ts'], exclude: INTEGRATION ? [] : ['**/*.integration.test.ts'] } };\n",
    )?;
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "workspace": {
                "root": ".",
                "fullFallback": { "taskIds": ["staff:test"] }
            },
            "projects": [{ "id": "staff", "root": "libs/staff" }],
            "tasks": [{
                "id": "staff:test",
                "project": "staff",
                "kind": "test",
                "execution": {
                    "executable": "vitest",
                    "args": ["run", "--root", "libs/staff"],
                    "fileNarrowing": {
                        "suffixes": [".test.ts"],
                        "excludeSuffixes": [".integration.test.ts", ".e2e.test.ts"]
                    }
                },
                "impact": { "mode": "reachability" }
            }]
        }))?,
    )?;
    git_init_commit(&dir)?;

    let resp = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Doctor,
        workspace_root: dir.display().to_string(),
        ..NativeRequest::default()
    });
    assert!(resp.ok, "{resp:?}");
    let doc = resp.result.ok_or("missing result")?.doctor.ok_or("missing doctor")?;
    assert!(!doc.ok);
    let codes: Vec<&str> = doc.findings.iter().map(|f| f.code.as_str()).collect();
    assert!(
        codes.contains(&"vitest-tier-missing-integration-target"),
        "expected vitest-tier-missing-integration-target in {codes:?}"
    );
    assert!(
        codes.contains(&"unowned-test-file"),
        "expected unowned-test-file in {codes:?}"
    );

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn doctor_catches_vitest_files_batch_root_exclude_mismatch_and_clears_with_dads_helper()
-> Result<(), Box<dyn Error>> {
    let dir = temp_ws("batch-mismatch")?;
    fs::create_dir_all(dir.join("apps/edge/src"))?;
    fs::write(dir.join("apps/edge/src/lifecycle.integration.test.ts"), "export const x = 1;\n")?;
    fs::write(
        dir.join("vitest.config.mts"),
        "export default { test: { exclude: ['**/node_modules/**', '**/*.integration.test.ts'] } };\n",
    )?;
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "workspace": {
                "root": ".",
                "fullFallback": { "taskIds": ["edge:test"] }
            },
            "projects": [{ "id": "edge", "root": "apps/edge" }],
            "tasks": [{
                "id": "edge:test",
                "project": "edge",
                "kind": "test",
                "execution": {
                    "executable": "vitest",
                    "args": ["run"],
                    "fileNarrowing": { "suffixes": [".test.ts"] },
                    "batch": { "mode": "vitest-files", "maxSize": 16, "groupKey": "vitest:unit" }
                },
                "impact": { "mode": "reachability" }
            }]
        }))?,
    )?;
    git_init_commit(&dir)?;

    let resp = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Doctor,
        workspace_root: dir.display().to_string(),
        ..NativeRequest::default()
    });
    assert!(resp.ok, "{resp:?}");
    let doc = resp.result.ok_or("missing result")?.doctor.ok_or("missing doctor")?;
    assert!(!doc.ok);
    assert!(
        doc.findings.iter().any(|f| f.code == "vitest-narrowing-mismatch"),
        "expected vitest-narrowing-mismatch, got {:?}",
        doc.findings
    );

    // Switching root vitest.config.mts to dadsVitestTier() makes batch runner obey DADS_TEST_EXPLICIT_FILES=1
    fs::write(
        dir.join("vitest.config.mts"),
        "import { dadsVitestTier } from '@dads-framework/testing/vitest';\nexport default { test: { ...dadsVitestTier({ tier: 'unit' }) } };\n",
    )?;
    let resp2 = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Doctor,
        workspace_root: dir.display().to_string(),
        ..NativeRequest::default()
    });
    assert!(resp2.ok, "{resp2:?}");
    let doc2 = resp2.result.ok_or("missing result")?.doctor.ok_or("missing doctor")?;
    assert!(doc2.ok, "expected clean doctor with dadsVitestTier, got {:?}", doc2.findings);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn doctor_catches_overlapping_narrowed_tasks_and_respects_exclude_args()
-> Result<(), Box<dyn Error>> {
    let dir = temp_ws("overlap")?;
    fs::create_dir_all(dir.join("scripts/ci"))?;
    fs::write(dir.join("scripts/ci/a.test.mjs"), "export const a = 1;\n")?;
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "workspace": {
                "root": ".",
                "fullFallback": { "taskIds": ["scripts:one", "scripts:two"] }
            },
            "projects": [{ "id": "scripts", "root": "scripts" }],
            "tasks": [
                {
                    "id": "scripts:one",
                    "project": "scripts",
                    "kind": "test",
                    "execution": {
                        "executable": "node",
                        "args": ["runner.mjs"],
                        "fileNarrowing": { "suffixes": [".test.mjs"] }
                    },
                    "impact": { "mode": "reachability" }
                },
                {
                    "id": "scripts:two",
                    "project": "scripts",
                    "kind": "test",
                    "execution": {
                        "executable": "node",
                        "args": ["runner2.mjs"],
                        "fileNarrowing": { "suffixes": [".test.mjs"] }
                    },
                    "impact": { "mode": "reachability" }
                }
            ]
        }))?,
    )?;
    git_init_commit(&dir)?;

    let resp = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Doctor,
        workspace_root: dir.display().to_string(),
        ..NativeRequest::default()
    });
    let doc = resp.result.ok_or("missing result")?.doctor.ok_or("missing doctor")?;
    assert!(!doc.ok);
    assert!(doc.findings.iter().any(|f| f.code == "overlapping-narrowing-targets"));

    // Adding --exclude scripts/ci/a.test.mjs on scripts:one resolves the overlap
    let updated = fs::read_to_string(dir.join("dads.testing.json"))?.replace(
        r#""runner.mjs""#,
        r#""runner.mjs", "--exclude", "scripts/ci/a.test.mjs""#,
    );
    fs::write(dir.join("dads.testing.json"), updated)?;
    let resp2 = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Doctor,
        workspace_root: dir.display().to_string(),
        ..NativeRequest::default()
    });
    let doc2 = resp2.result.ok_or("missing result")?.doctor.ok_or("missing doctor")?;
    assert!(doc2.ok, "expected clean doctor once excluded, got {:?}", doc2.findings);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
