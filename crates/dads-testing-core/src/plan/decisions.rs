//! Why each declared task runs or is skipped. The reason is chosen from the strongest evidence
//! that applies, and the same evidence is turned into the located causes the decision cites.
use super::{PlanEvidence, Selection};
use crate::execute::{TestingError, message};
use crate::graph::DependencyGraph;
use crate::manifest::{DeclaredTask, ImpactMode, TestingManifest, task_order};
use crate::protocol::{ResolvedScope, TaskDecision};
use crate::task_causes::CauseEvidence;
use std::collections::BTreeMap;

pub(super) fn explain_decisions<'a>(
    manifest: &'a TestingManifest,
    scope: &ResolvedScope,
    graph: Option<&DependencyGraph>,
    task_by_id: &BTreeMap<&'a str, &'a DeclaredTask>,
    evidence: &PlanEvidence<'a>,
    selection: &Selection<'a>,
) -> Result<Vec<TaskDecision>, TestingError> {
    let causes = CauseEvidence {
        manifest,
        graph,
        selected: &selection.selected,
        changed_paths: &scope.changed_paths,
        changed_paths_by_project: &evidence.changed_paths_by_project,
        issue_indexes_by_project: &evidence.issue_indexes_by_project,
        full_fallback_issue_indexes: &evidence.full_fallback_issue_indexes,
        fallback_origins: &selection.fallback_origins,
        uncertainty_origins: &selection.uncertainty_origins,
        reached_edges: &evidence.reached_edges,
    };
    let mut decisions = Vec::new();
    for id in task_order(&manifest.tasks)? {
        let task = task_by_id
            .get(id.as_str())
            .ok_or_else(|| message(format!("Unknown task {id}.")))?;
        let _declared_kind = &task.kind;
        let run = selection.selected.contains(id.as_str());
        let (reason, confidence, widened) =
            decision_reason(manifest, scope, evidence, selection, &causes, task);
        let reached_files = if run
            && task.impact.mode == ImpactMode::Reachability
            && !widened
            && !scope.full_fallback
            && !evidence.full_fallback
        {
            evidence.reached_files_for_project(&task.project)
        } else {
            Vec::new()
        };
        let selected_files = if run && task.impact.mode == ImpactMode::Reachability {
            evidence
                .narrowed_files_for_task(task, scope)
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        decisions.push(TaskDecision {
            decision: if run {
                "run".into()
            } else {
                "skip-proven-unaffected".into()
            },
            reason: reason.to_owned(),
            confidence: confidence.to_owned(),
            widened,
            project: task.project.clone(),
            causes: causes.for_task(task, reason),
            reached_files,
            selected_files,
            id,
        });
    }
    Ok(decisions)
}

/// The reason, its confidence, and whether the selection was widened past proven impact. The
/// branches are ordered strongest evidence first: an explicit request outranks a proof, a proof
/// outranks a widening, and "proven-unaffected" is what is left when nothing selected the task.
fn decision_reason(
    manifest: &TestingManifest,
    scope: &ResolvedScope,
    evidence: &PlanEvidence<'_>,
    selection: &Selection<'_>,
    causes: &CauseEvidence<'_>,
    task: &DeclaredTask,
) -> (&'static str, &'static str, bool) {
    let id = task.id.as_str();
    let run = selection.selected.contains(id);
    if selection.direct_tasks.contains(id) {
        return ("direct-task-input", "explicit", false);
    }
    if scope.full_fallback || evidence.full_fallback {
        return ("full-fallback", "conservative", false);
    }
    if task.impact.mode == ImpactMode::Always {
        return ("impact-always", "explicit", false);
    }
    if run && task.impact.mode == ImpactMode::ChangedFiles && causes.has_changed_file_input(task) {
        return ("changed-file-input", "explicit", false);
    }
    if run && task.impact.mode == ImpactMode::Reachability && evidence.is_widened_for_task(task) {
        return ("graph-uncertainty-project-fallback", "conservative", true);
    }
    if manifest.tasks.iter().any(|candidate| {
        candidate
            .depends_on
            .iter()
            .any(|dependency| dependency == id)
            && selection.selected.contains(candidate.id.as_str())
    }) && !evidence
        .fallback_impacted_projects
        .contains(task.project.as_str())
        && !evidence.is_reachability_impacted_for_task(task)
    {
        return ("selected-prerequisite", "dependency", false);
    }
    if run
        && task.impact.mode == ImpactMode::Reachability
        && evidence.changed_projects.contains(task.project.as_str())
    {
        return ("graph-changed-export", "graph-symbol-derived", false);
    }
    if run && task.impact.mode == ImpactMode::Reachability {
        return ("graph-symbol-importer", "graph-symbol-derived", false);
    }
    if run
        && evidence
            .fallback_impacted_projects
            .contains(task.project.as_str())
    {
        return ("changed-owned-project", "conservative", false);
    }
    ("proven-unaffected", "proven", false)
}
