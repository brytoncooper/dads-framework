//! Loading and filtering a precomputed `dad-test plan --json` file for `dad-test run --plan-file`.
//! Accepts either the CLI JSON envelope (`{ schemaVersion, ok, result }`), a raw native response
//! (`{ schemaVersion, ok, result: { plan } }`), or a bare `PlanResult` JSON object.

use crate::execute::{TestingError, message};
use crate::manifest::{DeclaredTask, TestingManifest};
use crate::plan::{PlanFilters, apply_plan_filters, parse_kind_filter, validate_shard};
use crate::plan_fingerprint::{compute_workspace_fingerprint, fingerprints_match};
use crate::protocol::{PROTOCOL_SCHEMA_VERSION, PlanCounts, PlanResult};
use crate::scheduler::should_guard_task;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Returns `true` when any runnable guarded task in the filtered `--plan-file` is missing a
/// precomputed `readGuardAllowlist`, meaning the CLI must load the workspace dependency graph so
/// `AllowlistBuilder` can compute accurate allowlists instead of falling back to an empty graph.
pub(crate) fn plan_file_missing_read_guard_allowlists(
    workspace_root: &Path,
    raw_path: &str,
    manifest: &TestingManifest,
    filters: &PlanFilters<'_>,
) -> bool {
    let Ok(plan) = load_plan_file(workspace_root, raw_path, manifest, filters, None) else {
        return false;
    };
    let task_by_id: BTreeMap<&str, &DeclaredTask> = manifest
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    plan.tasks.iter().any(|decision| {
        decision.decision == "run"
            && decision.read_guard_allowlist.is_none()
            && task_by_id
                .get(decision.id.as_str())
                .is_some_and(|task| should_guard_task(&task.kind, &task.execution))
    })
}

pub(crate) fn load_plan_file(
    workspace_root: &Path,
    raw_path: &str,
    manifest: &TestingManifest,
    filters: &PlanFilters<'_>,
    jobs: Option<u32>,
) -> Result<PlanResult, TestingError> {
    if matches!(jobs, Some(0)) {
        return Err(message("jobs must be greater than zero."));
    }
    let kind_filter = parse_kind_filter(filters.task_kinds)?;
    validate_shard(filters.shard)?;

    let resolved = resolve_plan_path(workspace_root, raw_path);
    let contents = fs::read_to_string(&resolved).map_err(|error| {
        message(format!(
            "Unable to read --plan-file '{}': {error}",
            resolved.display()
        ))
    })?;
    let parsed: Value = serde_json::from_str(&contents).map_err(|error| {
        message(format!(
            "Invalid JSON in --plan-file '{}': {error}",
            resolved.display()
        ))
    })?;

    let mut plan = unwrap_plan_result(parsed, &resolved)?;
    if plan.schema_version != PROTOCOL_SCHEMA_VERSION {
        return Err(message(format!(
            "Unsupported plan schemaVersion {} in --plan-file '{}'. Expected {}.",
            plan.schema_version,
            resolved.display(),
            PROTOCOL_SCHEMA_VERSION
        )));
    }
    verify_plan_freshness(workspace_root, &resolved, manifest, &plan)?;

    let task_by_id: BTreeMap<&str, &DeclaredTask> = manifest
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();

    for decision in &mut plan.tasks {
        match task_by_id.get(decision.id.as_str()) {
            Some(task) => {
                if decision.project.is_empty() {
                    decision.project = task.project.clone();
                }
            }
            None if decision.decision == "run" => {
                return Err(message(format!(
                    "--plan-file '{}' references unknown runnable task '{}' not declared in the manifest.",
                    resolved.display(),
                    decision.id
                )));
            }
            None => {}
        }
    }

    let shard = apply_plan_filters(
        &mut plan.tasks,
        &task_by_id,
        kind_filter.as_deref(),
        filters,
    );
    if shard.is_some() {
        plan.shard = shard;
    }
    let run = plan
        .tasks
        .iter()
        .filter(|decision| decision.decision == "run")
        .count();
    let skip_proven_unaffected = plan.tasks.len() - run;
    plan.counts = PlanCounts {
        run,
        skip_proven_unaffected,
    };
    Ok(plan)
}

fn resolve_plan_path(workspace_root: &Path, raw_path: &str) -> PathBuf {
    let candidate = Path::new(raw_path);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        workspace_root.join(candidate)
    }
}

fn verify_plan_freshness(
    workspace_root: &Path,
    plan_file: &Path,
    manifest: &TestingManifest,
    plan: &PlanResult,
) -> Result<(), TestingError> {
    if !plan.tasks.iter().any(|task| task.decision != "run") {
        return Ok(());
    }
    let Some(expected) = &plan.workspace_fingerprint else {
        return Ok(());
    };
    let actual = compute_workspace_fingerprint(workspace_root, &manifest.workspace.ignore_paths)
        .ok_or_else(|| {
            message(format!(
                "--plan-file '{}' cannot verify workspace freshness because Git state is unavailable. Re-run dad-test plan.",
                plan_file.display()
            ))
        })?;
    let canonical_plan = plan_file
        .canonicalize()
        .unwrap_or_else(|_| plan_file.to_path_buf());
    let excluded_rel = canonical_plan
        .strip_prefix(workspace_root)
        .ok()
        .map(|rel| rel.to_string_lossy().replace('\\', "/"));
    if !fingerprints_match(expected, &actual, excluded_rel.as_deref()) {
        return Err(message(format!(
            "--plan-file '{}' is stale: workspace HEAD or working tree changed since the plan was generated. Re-run dad-test plan.",
            plan_file.display()
        )));
    }
    Ok(())
}

fn unwrap_plan_result(value: Value, path: &Path) -> Result<PlanResult, TestingError> {
    let Some(object) = value.as_object() else {
        return Err(message(format!(
            "--plan-file '{}' must contain a JSON object.",
            path.display()
        )));
    };
    if let Some(ok_value) = object.get("ok") {
        let ok = ok_value.as_bool().ok_or_else(|| {
            message(format!(
                "--plan-file '{}' has a non-boolean 'ok' envelope field.",
                path.display()
            ))
        })?;
        if let Some(version) = object.get("schemaVersion").and_then(Value::as_u64)
            && version != u64::from(PROTOCOL_SCHEMA_VERSION)
        {
            return Err(message(format!(
                "Unsupported envelope schemaVersion {version} in --plan-file '{}'. Expected {}.",
                path.display(),
                PROTOCOL_SCHEMA_VERSION
            )));
        }
        if !ok {
            let detail = object
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Err(message(format!(
                "--plan-file '{}' contains a failed plan: {detail}",
                path.display()
            )));
        }
        let result = object.get("result").cloned().ok_or_else(|| {
            message(format!(
                "--plan-file '{}' envelope is missing 'result'.",
                path.display()
            ))
        })?;
        let plan_value =
            if let Some(inner_plan) = result.as_object().and_then(|map| map.get("plan")) {
                inner_plan.clone()
            } else {
                result
            };
        return serde_json::from_value::<PlanResult>(plan_value).map_err(|error| {
            message(format!(
                "Invalid plan result in --plan-file '{}': {error}",
                path.display()
            ))
        });
    }
    serde_json::from_value::<PlanResult>(value).map_err(|error| {
        message(format!(
            "Invalid plan result in --plan-file '{}': {error}",
            path.display()
        ))
    })
}
