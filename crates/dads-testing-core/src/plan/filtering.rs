//! Post-plan selection filters (kind, target name, project inclusion/exclusion) and
//! deterministic project-grouped LPT sharding applied after full planning.

use crate::execute::{TestingError, message};
use crate::manifest::{DeclaredTask, FileNarrowing, TaskKind};
use crate::protocol::{PlanShardMetadata, TaskDecision, TaskShard};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) struct PlanFilters<'a> {
    pub(crate) task_kinds: &'a [String],
    pub(crate) targets: &'a [String],
    pub(crate) projects: &'a [String],
    pub(crate) exclude_projects: &'a [String],
    pub(crate) shard: Option<TaskShard>,
    pub(crate) shard_weights: &'a BTreeMap<String, f64>,
    pub(crate) enforce_declared_reads: bool,
}

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

pub(crate) fn parse_kind_filter(
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

pub(crate) fn validate_shard(shard: Option<TaskShard>) -> Result<(), TestingError> {
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

pub(crate) fn apply_plan_filters(
    decisions: &mut Vec<TaskDecision>,
    task_by_id: &BTreeMap<&str, &DeclaredTask>,
    kind_filter: Option<&[TaskKind]>,
    filters: &PlanFilters<'_>,
) -> Option<PlanShardMetadata> {
    if let Some(allowed_kinds) = kind_filter {
        decisions.retain(|decision| {
            task_by_id
                .get(decision.id.as_str())
                .is_some_and(|task| allowed_kinds.contains(&task.kind))
        });
    }
    if !filters.targets.is_empty() {
        let allowed: BTreeSet<&str> = filters.targets.iter().map(String::as_str).collect();
        decisions.retain(|decision| {
            task_target_name(&decision.id, &decision.project)
                .is_some_and(|target| allowed.contains(target))
        });
    }
    if !filters.projects.is_empty() {
        let allowed: BTreeSet<&str> = filters.projects.iter().map(String::as_str).collect();
        decisions.retain(|decision| allowed.contains(decision.project.as_str()));
    }
    if !filters.exclude_projects.is_empty() {
        let excluded: BTreeSet<&str> = filters
            .exclude_projects
            .iter()
            .map(String::as_str)
            .collect();
        decisions.retain(|decision| !excluded.contains(decision.project.as_str()));
    }
    filters
        .shard
        .map(|shard| apply_weighted_project_shard(decisions, shard, filters.shard_weights))
}

fn task_target_name<'a>(task_id: &'a str, project: &str) -> Option<&'a str> {
    if let Some(rest) = task_id.strip_prefix(project)
        && let Some(target) = rest.strip_prefix(':')
        && !target.is_empty()
    {
        return Some(target);
    }
    task_id.rsplit_once(':').map(|(_, target)| target)
}

/// Assigns runnable projects across shards using deterministic Longest-Processing-Time (LPT)
/// bin-packing (ties broken alphabetically by project ID, then lowest bucket index) so all
/// runnable targets for a project stay together on the same shard and heavy projects spread
/// evenly across CI shards.
fn apply_weighted_project_shard(
    decisions: &mut Vec<TaskDecision>,
    shard: TaskShard,
    weights: &BTreeMap<String, f64>,
) -> PlanShardMetadata {
    let mut total_runnable_tasks = 0_usize;
    let mut project_weights: BTreeMap<String, f64> = BTreeMap::new();
    for decision in decisions.iter().filter(|d| d.decision == "run") {
        total_runnable_tasks += 1;
        let w = weights
            .get(&decision.id)
            .or_else(|| weights.get(&decision.project))
            .copied()
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(1.0);
        *project_weights
            .entry(decision.project.clone())
            .or_insert(0.0) += w;
    }
    let total_projects = project_weights.len();
    let total_weight: f64 = project_weights.values().sum();
    let mut ranked: Vec<(String, f64)> = project_weights.into_iter().collect();
    ranked.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    let total = usize::try_from(shard.total).unwrap_or(1).max(1);
    let target_bucket = usize::try_from(shard.index.saturating_sub(1)).unwrap_or(0);
    let mut loads = vec![0.0_f64; total];
    let mut selected_projects = BTreeSet::new();
    for (project, weight) in ranked {
        let bucket = loads
            .iter()
            .enumerate()
            .min_by(|(idx_a, load_a), (idx_b, load_b)| {
                load_a.total_cmp(load_b).then_with(|| idx_a.cmp(idx_b))
            })
            .map_or(0, |(idx, _)| idx);
        loads[bucket] += weight;
        if bucket == target_bucket {
            selected_projects.insert(project);
        }
    }
    let shard_weight = loads.get(target_bucket).copied().unwrap_or(0.0);
    decisions.retain(|decision| {
        decision.decision != "run" || selected_projects.contains(decision.project.as_str())
    });
    let selected_runnable_tasks = decisions.iter().filter(|d| d.decision == "run").count();
    PlanShardMetadata {
        index: shard.index,
        total: shard.total,
        weighted: !weights.is_empty(),
        total_projects,
        selected_projects: selected_projects.len(),
        total_runnable_tasks,
        selected_runnable_tasks,
        shard_weight,
        total_weight,
    }
}
