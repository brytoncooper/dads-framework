//! Where the snapshot store's issues land in the emitted plan.
//!
//! A decision cites an issue by its position in `plan.issues`, so the CLI appending the store's
//! own issues after the core's is load-bearing rather than cosmetic: prepending them would keep
//! every index numerically valid while making each one name a different issue. This test pins the
//! order by following a real cause index back to the issue the planner meant.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

mod workspace;

use serde_json::{Value, json};
use workspace::{TemporaryWorkspace, issue_codes};

/// Every code graph analysis can report, the snapshot store's included. Nothing the planner emits
/// uses either prefix.
const STORE_CODE_PREFIXES: [&str; 2] = ["graph-", "snapshot-"];

#[test]
fn store_issues_are_appended_after_the_core_issues_a_decision_cites() {
    let workspace = TemporaryWorkspace::create("plan-issue-order", &reachability_manifest());
    workspace.write("unowned.ts", "export const loose = true;\n");

    let plan = workspace.plan();
    let issues = plan["issues"].as_array().expect("issues must be an array");

    assert_eq!(issues[0]["code"], "unknown-changed-path");
    let cited = cited_issue_indexes(&plan);
    assert!(!cited.is_empty(), "a decision must cite an issue: {plan}");
    for index in cited {
        assert_eq!(
            issues[index]["code"], "unknown-changed-path",
            "cause index {index} must still name the planner's own issue: {plan}"
        );
    }

    let store_positions = issue_codes(&plan)
        .iter()
        .enumerate()
        .filter(|(_, code)| is_store_code(code))
        .map(|(position, _)| position)
        .collect::<Vec<_>>();
    assert!(
        !store_positions.is_empty(),
        "the store must report at least one issue: {plan}"
    );
    let first_store = store_positions[0];
    assert!(
        (first_store..issues.len()).eq(store_positions.iter().copied()),
        "store issues must be the tail of the list: {plan}"
    );
    assert!(
        first_store > 0,
        "core issues must keep the front of the list: {plan}"
    );
}

/// Every issue index a task decision cites, in the order the decisions carry them.
fn cited_issue_indexes(plan: &Value) -> Vec<usize> {
    plan["tasks"]
        .as_array()
        .expect("tasks must be an array")
        .iter()
        .flat_map(|task| {
            task["causes"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
        })
        .filter(|cause| cause["kind"] == "issue")
        .map(|cause| {
            usize::try_from(cause["index"].as_u64().expect("an index must be a number"))
                .expect("an index must fit this platform")
        })
        .collect()
}

fn is_store_code(code: &str) -> bool {
    STORE_CODE_PREFIXES
        .iter()
        .any(|prefix| code.starts_with(prefix))
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
