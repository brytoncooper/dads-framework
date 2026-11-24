//! Task-kind and deterministic round-robin sharding filters applied after full graph planning.

use crate::execute::{TestingError, message};
use crate::manifest::{DeclaredTask, FileNarrowing, TaskKind};
use crate::protocol::{TaskDecision, TaskShard};
use std::collections::BTreeMap;

pub(super) fn matches_file_narrowing(path: &str, narrowing: &FileNarrowing) -> bool {
    narrowing
        .suffixes
        .iter()
        .any(|suffix| path.ends_with(suffix))
        && !narrowing
            .exclude_suffixes
            .iter()
            .any(|excluded| path.ends_with(excluded))
}

pub(super) fn parse_kind_filter(
    requested: &[String],
) -> Result<Option<Vec<TaskKind>>, TestingError> {
    if requested.is_empty() {
        return Ok(None);
    }
    let mut kinds = Vec::new();
    for raw in requested {
        let parsed = match raw.trim() {
            "test" => TaskKind::Test,
            "typecheck" => TaskKind::Typecheck,
            "lint" => TaskKind::Lint,
            "build" => TaskKind::Build,
            "custom" => TaskKind::Custom,
            other => {
                return Err(message(format!(
                    "Unsupported task kind '{other}'. Expected one of: test, typecheck, lint, build, custom."
                )));
            }
        };
        if !kinds.contains(&parsed) {
            kinds.push(parsed);
        }
    }
    Ok(Some(kinds))
}

pub(super) fn validate_shard(shard: Option<TaskShard>) -> Result<(), TestingError> {
    let Some(shard) = shard else {
        return Ok(());
    };
    if shard.total == 0 {
        return Err(message("shard total must be greater than zero."));
    }
    if shard.index == 0 || shard.index > shard.total {
        return Err(message(format!(
            "shard index {} must be between 1 and {}.",
            shard.index, shard.total
        )));
    }
    Ok(())
}

pub(super) fn apply_kind_and_shard_filters(
    decisions: &mut Vec<TaskDecision>,
    task_by_id: &BTreeMap<&str, &DeclaredTask>,
    kind_filter: Option<&[TaskKind]>,
    shard: Option<TaskShard>,
) {
    if let Some(allowed_kinds) = kind_filter {
        decisions.retain(|decision| {
            task_by_id
                .get(decision.id.as_str())
                .is_some_and(|task| allowed_kinds.contains(&task.kind))
        });
    }
    if let Some(shard) = shard {
        let mut run_index: u32 = 0;
        decisions.retain(|decision| {
            if decision.decision != "run" {
                return true;
            }
            let belongs = (run_index % shard.total) + 1 == shard.index;
            run_index += 1;
            belongs
        });
    }
}
