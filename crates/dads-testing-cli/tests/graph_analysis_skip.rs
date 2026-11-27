//! What the binary analyzes, and what it reports when it analyzes nothing.
//!
//! Producing a dependency graph means parsing the whole workspace and reading or rewriting the
//! persisted snapshot. A manifest whose tasks all decide from the changed paths alone can never
//! read that graph, so the binary must skip the work outright and say so — and a manifest with a
//! single `reachability` task must still get its graph.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

mod workspace;

use serde_json::{Value, json};
use workspace::{TemporaryWorkspace, issue_codes};

/// Every snapshot-store code names an analysis that happened; none may appear when it is skipped.
const STORE_CODE_PREFIXES: [&str; 2] = ["graph-snapshot", "graph-initial"];

#[test]
fn a_manifest_without_a_graph_reader_skips_the_analysis_and_says_so() {
    let workspace = TemporaryWorkspace::create("graph-analysis-skip", &graphless_manifest());
    workspace.write("app/index.ts", "export const value = 2;\n");

    let plan = workspace.plan();

    assert_eq!(
        issue_codes(&plan),
        vec!["graph-analysis-unneeded"],
        "{plan}"
    );
    assert_eq!(plan["tasks"][0]["decision"], "run", "{plan}");
    assert_eq!(plan["tasks"][0]["reason"], "impact-always", "{plan}");
    assert_eq!(plan["tasks"][1]["reason"], "changed-file-input", "{plan}");
    assert_eq!(plan["counts"]["run"], 2, "{plan}");
}

/// The skip is decided from the manifest alone, so it must not swallow the conservative fallback
/// a path no project owns forces.
#[test]
fn an_unowned_changed_path_still_selects_the_complete_fallback_without_analysis() {
    let workspace = TemporaryWorkspace::create("graph-analysis-unowned", &graphless_manifest());
    workspace.write("loose.ts", "export const loose = true;\n");

    let plan = workspace.plan();

    assert_eq!(
        issue_codes(&plan),
        vec!["unknown-changed-path", "graph-analysis-unneeded"],
        "{plan}"
    );
    assert_eq!(plan["scope"]["fullFallback"], true, "{plan}");
    assert_eq!(plan["counts"]["skipProvenUnaffected"], 0, "{plan}");
}

#[test]
fn one_reachability_task_still_gets_its_graph_analyzed() {
    let workspace = TemporaryWorkspace::create("graph-analysis-needed", &reachability_manifest());
    workspace.write("app/index.ts", "export const value = 2;\n");

    let codes = issue_codes(&workspace.plan());

    assert!(
        codes.iter().any(|code| is_store_code(code)),
        "the graph must still be analyzed: {codes:?}"
    );
    assert!(
        !codes.iter().any(|code| code == "graph-analysis-unneeded"),
        "an analyzed graph must not be reported as unneeded: {codes:?}"
    );
}

#[test]
fn run_with_plan_file_skips_graph_analysis_even_for_reachability_manifest() {
    let workspace = TemporaryWorkspace::create("plan-file-skip-graph", &reachability_manifest());
    let plan_envelope = json!({
        "schemaVersion": 1,
        "ok": true,
        "result": {
            "schemaVersion": 1,
            "scope": {
                "kind": "working-tree",
                "changedPaths": ["app/index.ts"],
                "fullFallback": false
            },
            "tasks": [{
                "id": "app:test",
                "decision": "run",
                "reason": "changed-path",
                "confidence": "proven",
                "widened": false,
                "project": "app"
            }],
            "issues": [],
            "complete": true,
            "counts": { "run": 1, "skipProvenUnaffected": 0 }
        }
    });
    workspace.write("precomputed-plan.json", &plan_envelope.to_string());

    let response = workspace.send_request(json!({
        "schemaVersion": 1,
        "operation": "run",
        "workspaceRoot": workspace.0.to_string_lossy(),
        "planFile": "precomputed-plan.json",
        "shard": { "index": 1, "total": 1 }
    }));
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["result"]["run"]["exitCode"], 0, "{response}");
    let codes = issue_codes(&response["result"]["plan"]);
    assert!(
        codes.is_empty(),
        "plan-file run must skip graph analysis completely, got issues: {codes:?}"
    );
}

#[test]
fn plan_file_with_enforce_declared_reads_preserves_uncacheable_allowlist_and_skips_graph() {
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["app:test"] },
            "enforceDeclaredReads": true
        },
        "projects": [
            { "id": "lib", "root": "libs/lib", "fallbackDependencies": [] },
            { "id": "app", "root": "apps/app", "fallbackDependencies": [] }
        ],
        "tasks": [{
            "id": "app:test",
            "project": "app",
            "kind": "test",
            "execution": { "executable": "node", "args": ["apps/app/suite.test.mjs"] },
            "dependsOn": [],
            "impact": { "mode": "reachability" }
        }]
    });
    let workspace = TemporaryWorkspace::create("plan-file-read-guard", &manifest);
    workspace.write("libs/lib/helper.mjs", "export const val = 42;\n");
    workspace.write("secret/undeclared.txt", "secret\n");
    // Non-literal dynamic import makes `app:test` `cacheable: false` while still statically
    // importing `libs/lib/helper.mjs`.
    workspace.write(
        "apps/app/suite.test.mjs",
        concat!(
            "import { val } from '../../libs/lib/helper.mjs';\n",
            "import { readFileSync } from 'node:fs';\n",
            "if (false) { const p = 'x'; await import(p); }\n",
            "readFileSync('libs/lib/helper.mjs', 'utf8');\n",
            "if (val !== 42) process.exit(1);\n",
        ),
    );

    let plan_resp = workspace.send_request(json!({
        "schemaVersion": 1,
        "operation": "plan",
        "workspaceRoot": workspace.0.to_string_lossy(),
        "all": true
    }));
    assert_eq!(plan_resp["ok"], true, "{plan_resp}");
    let app_plan = &plan_resp["result"]["plan"]["tasks"][0];
    assert_eq!(app_plan["cacheInputs"]["cacheable"], false, "{app_plan}");
    let allow_roots = app_plan["readGuardAllowlist"]["allowedProjectRoots"]
        .as_array()
        .expect("expected precomputed readGuardAllowlist");
    assert!(
        allow_roots.iter().any(|v| v == "libs/lib"),
        "expected libs/lib in precomputed allowlist: {app_plan}"
    );

    let mut plan_for_file = plan_resp.clone();
    plan_for_file["result"]["plan"]["issues"] = json!([]);
    workspace.write("plan-with-allowlist.json", &plan_for_file.to_string());
    let run_resp = workspace.send_request(json!({
        "schemaVersion": 1,
        "operation": "run",
        "workspaceRoot": workspace.0.to_string_lossy(),
        "planFile": "plan-with-allowlist.json"
    }));
    assert_eq!(run_resp["ok"], true, "{run_resp}");
    assert_eq!(run_resp["result"]["run"]["exitCode"], 0, "{run_resp}");
    let codes = issue_codes(&run_resp["result"]["plan"]);
    assert!(
        codes.is_empty(),
        "plan-file with readGuardAllowlist must skip graph analysis: {codes:?}"
    );

    // Strip `readGuardAllowlist` to simulate an older plan file: CLI must load graph and pass.
    let mut legacy_plan = plan_resp.clone();
    legacy_plan["result"]["plan"]["tasks"][0]
        .as_object_mut()
        .unwrap()
        .remove("readGuardAllowlist");
    workspace.write("legacy-plan.json", &legacy_plan.to_string());
    let legacy_resp = workspace.send_request(json!({
        "schemaVersion": 1,
        "operation": "run",
        "workspaceRoot": workspace.0.to_string_lossy(),
        "planFile": "legacy-plan.json"
    }));
    assert_eq!(legacy_resp["ok"], true, "{legacy_resp}");
    assert_eq!(legacy_resp["result"]["run"]["exitCode"], 0, "{legacy_resp}");

    // Real undeclared reads MUST still fail under `--plan-file`!
    workspace.write(
        "apps/app/suite.test.mjs",
        concat!(
            "import { val } from '../../libs/lib/helper.mjs';\n",
            "import { readFileSync } from 'node:fs';\n",
            "readFileSync('secret/undeclared.txt', 'utf8');\n",
            "if (val !== 42) process.exit(1);\n",
        ),
    );
    let fail_resp = workspace.send_request(json!({
        "schemaVersion": 1,
        "operation": "run",
        "workspaceRoot": workspace.0.to_string_lossy(),
        "planFile": "plan-with-allowlist.json"
    }));
    assert_eq!(fail_resp["ok"], true, "{fail_resp}");
    assert_eq!(fail_resp["result"]["run"]["exitCode"], 1, "{fail_resp}");
    let reads = fail_resp["result"]["run"]["tasks"][0]["undeclaredReads"]
        .as_array()
        .expect("expected undeclaredReads");
    assert_eq!(reads[0]["path"], "secret/undeclared.txt", "{fail_resp}");
}

#[test]
fn narrowed_plan_file_walks_project_vitest_config_imports() {
    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["web:test"] },
            "enforceDeclaredReads": true
        },
        "projects": [
            { "id": "web", "root": "apps/web", "fallbackDependencies": [] },
            { "id": "sequencer", "root": "tools/sequencer", "fallbackDependencies": [] }
        ],
        "tasks": [{
            "id": "web:test",
            "project": "web",
            "kind": "test",
            "execution": {
                "executable": "node",
                "args": [],
                "fileNarrowing": { "suffixes": [".test.mjs"] }
            },
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": ["apps/web/vitest.config.mts"] }
        }]
    });
    let workspace = TemporaryWorkspace::create("narrowed-vitest-cfg", &manifest);
    workspace.write("tools/sequencer/index.mjs", "export const seq = 1;\n");
    workspace.write(
        "apps/web/vitest.config.mts",
        "import { seq } from '../../tools/sequencer/index.mjs';\nexport default { seq };\n",
    );
    workspace.write("apps/web/src/util.mjs", "export const x = 1;\n");
    workspace.write(
        "apps/web/src/a.test.mjs",
        "import { readFileSync } from 'node:fs';\nimport { x } from './util.mjs';\nif (!x) process.exit(1);\nreadFileSync('tools/sequencer/index.mjs', 'utf8');\n",
    );
    workspace.write("apps/web/src/b.test.mjs", "export const b = 1;\n");
    workspace.git(&["add", "--all"]);
    workspace.git(&["commit", "--quiet", "--message", "add web and sequencer"]);

    // Edit only util.mjs so `plan` narrows `selectedFiles` to ["apps/web/src/a.test.mjs"].
    workspace.write("apps/web/src/util.mjs", "export const x = 2;\n");

    let plan_resp = workspace.send_request(json!({
        "schemaVersion": 1,
        "operation": "plan",
        "workspaceRoot": workspace.0.to_string_lossy()
    }));
    assert_eq!(plan_resp["ok"], true, "{plan_resp}");
    let web_plan = &plan_resp["result"]["plan"]["tasks"][0];
    assert_eq!(
        web_plan["selectedFiles"],
        json!(["apps/web/src/a.test.mjs"]),
        "{web_plan}"
    );
    let allow_roots = web_plan["readGuardAllowlist"]["allowedProjectRoots"]
        .as_array()
        .expect("expected precomputed readGuardAllowlist");
    assert!(
        allow_roots.iter().any(|v| v == "tools/sequencer"),
        "expected vitest config dependency tools/sequencer in narrowed allowlist: {web_plan}"
    );

    workspace.write("narrowed-plan.json", &plan_resp.to_string());
    let run_resp = workspace.send_request(json!({
        "schemaVersion": 1,
        "operation": "run",
        "workspaceRoot": workspace.0.to_string_lossy(),
        "planFile": "narrowed-plan.json"
    }));
    assert_eq!(run_resp["ok"], true, "{run_resp}");
    assert_eq!(run_resp["result"]["run"]["exitCode"], 0, "{run_resp}");
}

fn is_store_code(code: &str) -> bool {
    STORE_CODE_PREFIXES
        .iter()
        .any(|prefix| code.starts_with(prefix))
}

/// One `always` task and one `changed-files` task: neither impact mode consults a graph.
fn graphless_manifest() -> Value {
    json!({
        "schemaVersion": 1,
        "workspace": {"root": ".", "fullFallback": {"taskIds": ["app:lint", "app:test"]}},
        "projects": [{"id": "app", "root": "app", "fallbackDependencies": []}],
        "tasks": [
            {
                "id": "app:lint",
                "project": "app",
                "kind": "lint",
                "execution": {"executable": "true"},
                "dependsOn": [],
                "impact": {"mode": "always"},
            },
            {
                "id": "app:test",
                "project": "app",
                "kind": "test",
                "execution": {"executable": "true"},
                "dependsOn": [],
                "impact": {"mode": "changed-files", "paths": ["app"]},
            },
        ],
    })
}

fn reachability_manifest() -> Value {
    json!({
        "schemaVersion": 1,
        "workspace": {"root": ".", "fullFallback": {"taskIds": ["app:test"]}},
        "projects": [{"id": "app", "root": "app", "fallbackDependencies": []}],
        "tasks": [{
            "id": "app:test",
            "project": "app",
            "kind": "test",
            "execution": {"executable": "true"},
            "dependsOn": [],
            "impact": {"mode": "reachability"},
        }],
    })
}
