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
