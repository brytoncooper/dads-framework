//! Planning one request: own the changed paths, widen through whatever graph evidence exists,
//! select the tasks that answer, and explain every decision with located evidence.
mod decisions;
mod widening;

use crate::execute::{TestingError, message};
use crate::graph::{DependencyGraph, ReachedEdge};
use crate::manifest::{DeclaredTask, FileNarrowing, ImpactMode, TaskKind, TestingManifest};
use crate::protocol::{PROTOCOL_SCHEMA_VERSION, PlanCounts, PlanIssue, PlanResult, ResolvedScope};
use crate::scope::{path_is_inside, path_matches_impact};
use crate::sql_impact::{SqlTaskSelection, analyze_sql_impact};
use decisions::explain_decisions;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;
use widening::{own_changed_paths, widen_through_graph};

/// What the changed paths and the graph proved, accumulated as the plan is built. The issue list
/// lives here because a decision cites an issue by its index in the emitted list.
struct PlanEvidence<'a> {
    changed_projects: BTreeSet<&'a str>,
    fallback_impacted_projects: BTreeSet<&'a str>,
    reachability_impacted_projects: BTreeSet<&'a str>,
    uncertainty_impacted_projects: BTreeSet<&'a str>,
    local_uncertainty_impacted_projects: BTreeSet<&'a str>,
    typecheck_reachability_impacted_projects: BTreeSet<&'a str>,
    typecheck_uncertainty_impacted_projects: BTreeSet<&'a str>,
    typecheck_local_uncertainty_impacted_projects: BTreeSet<&'a str>,
    changed_paths_by_project: BTreeMap<&'a str, Vec<String>>,
    reached_paths: BTreeSet<String>,
    reached_paths_by_project: BTreeMap<&'a str, BTreeSet<String>>,
    issue_indexes_by_project: BTreeMap<&'a str, Vec<usize>>,
    full_fallback_issue_indexes: Vec<usize>,
    reached_edges: Vec<ReachedEdge>,
    sql_handled_paths: BTreeSet<String>,
    sql_selected_tasks: BTreeMap<String, SqlTaskSelection>,
    issues: Vec<PlanIssue>,
    full_fallback: bool,
}

impl<'a> PlanEvidence<'a> {
    fn new(scope: &ResolvedScope) -> Self {
        Self {
            changed_projects: BTreeSet::new(),
            fallback_impacted_projects: BTreeSet::new(),
            reachability_impacted_projects: BTreeSet::new(),
            uncertainty_impacted_projects: BTreeSet::new(),
            local_uncertainty_impacted_projects: BTreeSet::new(),
            typecheck_reachability_impacted_projects: BTreeSet::new(),
            typecheck_uncertainty_impacted_projects: BTreeSet::new(),
            typecheck_local_uncertainty_impacted_projects: BTreeSet::new(),
            changed_paths_by_project: BTreeMap::new(),
            reached_paths: BTreeSet::new(),
            reached_paths_by_project: BTreeMap::new(),
            issue_indexes_by_project: BTreeMap::new(),
            full_fallback_issue_indexes: Vec::new(),
            reached_edges: Vec::new(),
            sql_handled_paths: BTreeSet::new(),
            sql_selected_tasks: BTreeMap::new(),
            issues: Vec::new(),
            full_fallback: scope.full_fallback,
        }
    }

    fn is_widened_for_task(&self, task: &DeclaredTask) -> bool {
        if matches!(task.kind, TaskKind::Test) {
            self.uncertainty_impacted_projects
                .contains(task.project.as_str())
        } else {
            self.typecheck_uncertainty_impacted_projects
                .contains(task.project.as_str())
        }
    }

    fn is_reachability_impacted_for_task(&self, task: &DeclaredTask) -> bool {
        if matches!(task.kind, TaskKind::Test) {
            self.reachability_impacted_projects
                .contains(task.project.as_str())
        } else {
            self.typecheck_reachability_impacted_projects
                .contains(task.project.as_str())
        }
    }

    fn setup_file_touched(&self, narrowing: &FileNarrowing, scope: &ResolvedScope) -> bool {
        narrowing.setup_files.iter().any(|setup| {
            scope
                .changed_paths
                .iter()
                .any(|changed| changed == setup || path_is_inside(changed, setup))
                || self
                    .reached_paths
                    .iter()
                    .any(|reached| reached == setup || path_is_inside(reached, setup))
        })
    }

    fn reached_files_for_project(&self, project: &str) -> Vec<String> {
        self.reached_paths_by_project
            .get(project)
            .map(|paths| paths.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn has_changed_file_input(&self, task: &DeclaredTask, scope: &ResolvedScope) -> bool {
        task.impact.paths.iter().any(|owned_path| {
            scope
                .changed_paths
                .iter()
                .any(|changed_path| path_matches_impact(changed_path, owned_path))
        })
    }

    fn narrowed_files_for_task(
        &self,
        task: &DeclaredTask,
        scope: &ResolvedScope,
    ) -> Option<Vec<String>> {
        if self.full_fallback
            || scope.full_fallback
            || self.is_widened_for_task(task)
            || self.sql_selected_tasks.contains_key(&task.id)
            || self.has_changed_file_input(task, scope)
        {
            return None;
        }
        let narrowing = task.execution.file_narrowing.as_ref()?;
        if self.setup_file_touched(narrowing, scope) {
            return None;
        }
        let selected = self
            .reached_files_for_project(&task.project)
            .into_iter()
            .filter(|path| matches_file_narrowing(path, narrowing))
            .collect::<Vec<_>>();
        Some(selected)
    }

    fn should_run(&self, task: &DeclaredTask, scope: &ResolvedScope) -> bool {
        if self.sql_selected_tasks.contains_key(&task.id) {
            return true;
        }
        match &task.impact.mode {
            ImpactMode::Always => true,
            ImpactMode::Reachability => {
                if self.has_changed_file_input(task, scope) {
                    return true;
                }
                if let Some(narrowing) = &task.execution.file_narrowing
                    && self.setup_file_touched(narrowing, scope)
                {
                    return true;
                }
                if !self.is_reachability_impacted_for_task(task) {
                    return false;
                }
                if let Some(selected_files) = self.narrowed_files_for_task(task, scope) {
                    return !selected_files.is_empty();
                }
                true
            }
            ImpactMode::Project => self
                .fallback_impacted_projects
                .contains(task.project.as_str()),
            ImpactMode::ChangedFiles => self.has_changed_file_input(task, scope),
        }
    }
}

fn matches_file_narrowing(path: &str, narrowing: &FileNarrowing) -> bool {
    narrowing
        .suffixes
        .iter()
        .any(|suffix| path.ends_with(suffix))
        && !narrowing
            .exclude_suffixes
            .iter()
            .any(|excluded| path.ends_with(excluded))
}

/// The selected task set together with the widening that produced it: which originally impacted
/// project put each dependent project in scope.
struct Selection<'a> {
    selected: BTreeSet<&'a str>,
    direct_tasks: BTreeSet<&'a str>,
    fallback_origins: BTreeMap<&'a str, BTreeSet<&'a str>>,
    uncertainty_origins: BTreeMap<&'a str, BTreeSet<&'a str>>,
}

pub(crate) fn build_plan(
    manifest: &TestingManifest,
    workspace_root: &Path,
    scope: &ResolvedScope,
    requested_task_ids: &[String],
    jobs: Option<u32>,
    graph: Option<&DependencyGraph>,
) -> Result<PlanResult, TestingError> {
    let task_by_id: BTreeMap<&str, &DeclaredTask> = manifest
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let direct_tasks = direct_task_inputs(&task_by_id, requested_task_ids)?;
    if matches!(jobs, Some(0)) {
        return Err(message("jobs must be greater than zero."));
    }
    let mut evidence = PlanEvidence::new(scope);
    own_changed_paths(manifest, scope, &mut evidence);
    attach_sql_impact(manifest, workspace_root, scope, &mut evidence);
    widen_through_graph(manifest, scope, graph, &mut evidence);
    let selection = select_tasks(manifest, scope, &task_by_id, direct_tasks, &mut evidence)?;
    let decisions = explain_decisions(manifest, scope, graph, &task_by_id, &evidence, &selection)?;
    let run = decisions
        .iter()
        .filter(|decision| decision.decision == "run")
        .count();
    Ok(PlanResult {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        scope: ResolvedScope {
            full_fallback: evidence.full_fallback,
            ..clone_scope(scope)
        },
        tasks: decisions,
        issues: evidence.issues,
        complete: true,
        counts: PlanCounts {
            run,
            skip_proven_unaffected: manifest.tasks.len() - run,
        },
    })
}

fn attach_sql_impact(
    manifest: &TestingManifest,
    workspace_root: &Path,
    scope: &ResolvedScope,
    evidence: &mut PlanEvidence<'_>,
) {
    if evidence.full_fallback {
        return;
    }
    let report = analyze_sql_impact(manifest, scope, workspace_root);
    let offset = evidence.issues.len();
    evidence.issues.extend(report.issues);
    evidence.sql_handled_paths = report.handled_paths;
    for (task_id, mut selection) in report.selected_tasks {
        for idx in &mut selection.issue_indexes {
            *idx += offset;
        }
        evidence.sql_selected_tasks.insert(task_id, selection);
    }
}

/// The tasks the caller named. An unknown id is a request error, not a widening.
fn direct_task_inputs<'a>(
    task_by_id: &BTreeMap<&'a str, &'a DeclaredTask>,
    requested_task_ids: &[String],
) -> Result<BTreeSet<&'a str>, TestingError> {
    let mut direct_tasks = BTreeSet::new();
    for id in requested_task_ids {
        let Some(task) = task_by_id.get(id.as_str()) else {
            return Err(message(format!("Unknown task input {id}.")));
        };
        direct_tasks.insert(task.id.as_str());
    }
    Ok(direct_tasks)
}

fn select_tasks<'a>(
    manifest: &'a TestingManifest,
    scope: &ResolvedScope,
    task_by_id: &BTreeMap<&'a str, &'a DeclaredTask>,
    direct_tasks: BTreeSet<&'a str>,
    evidence: &mut PlanEvidence<'a>,
) -> Result<Selection<'a>, TestingError> {
    let mut selected: BTreeSet<&'a str> = direct_tasks.iter().copied().collect();
    let mut fallback_origins = BTreeMap::new();
    let mut uncertainty_origins = BTreeMap::new();
    if evidence.full_fallback {
        selected.extend(task_by_id.keys().copied());
    } else {
        fallback_origins =
            propagate_fallback_dependents(manifest, &mut evidence.fallback_impacted_projects);
        uncertainty_origins =
            propagate_fallback_dependents(manifest, &mut evidence.uncertainty_impacted_projects);
        let typecheck_uncertainty_origins = propagate_fallback_dependents(
            manifest,
            &mut evidence.typecheck_uncertainty_impacted_projects,
        );
        for (project, origins) in typecheck_uncertainty_origins {
            uncertainty_origins
                .entry(project)
                .or_default()
                .extend(origins);
        }
        merge_local_uncertainties(evidence, &mut uncertainty_origins);
        let widened = evidence
            .uncertainty_impacted_projects
            .iter()
            .copied()
            .collect::<Vec<_>>();
        evidence.reachability_impacted_projects.extend(widened);
        let typecheck_widened = evidence
            .typecheck_uncertainty_impacted_projects
            .iter()
            .copied()
            .collect::<Vec<_>>();
        evidence
            .typecheck_reachability_impacted_projects
            .extend(typecheck_widened);
        for task in &manifest.tasks {
            if evidence.should_run(task, scope) {
                selected.insert(task.id.as_str());
            }
        }
    }
    add_prerequisites(task_by_id, &mut selected)?;
    Ok(Selection {
        selected,
        direct_tasks,
        fallback_origins,
        uncertainty_origins,
    })
}

fn merge_local_uncertainties<'a>(
    evidence: &mut PlanEvidence<'a>,
    uncertainty_origins: &mut BTreeMap<&'a str, BTreeSet<&'a str>>,
) {
    for &p in &evidence.local_uncertainty_impacted_projects {
        evidence.uncertainty_impacted_projects.insert(p);
        uncertainty_origins.entry(p).or_default().insert(p);
    }
    for &p in &evidence.typecheck_local_uncertainty_impacted_projects {
        evidence.typecheck_uncertainty_impacted_projects.insert(p);
        uncertainty_origins.entry(p).or_default().insert(p);
    }
}

fn clone_scope(scope: &ResolvedScope) -> ResolvedScope {
    ResolvedScope {
        kind: scope.kind.clone(),
        base: scope.base.clone(),
        head: scope.head.clone(),
        changed_paths: scope.changed_paths.clone(),
        full_fallback: scope.full_fallback,
    }
}

/// Widens an impacted-project set through declared fallback dependencies and reports, for every
/// impacted project, which originally impacted projects put it there. A project that was impacted
/// on its own account is its own origin.
fn propagate_fallback_dependents<'a>(
    manifest: &'a TestingManifest,
    impacted: &mut BTreeSet<&'a str>,
) -> BTreeMap<&'a str, BTreeSet<&'a str>> {
    let mut origins: BTreeMap<&'a str, BTreeSet<&'a str>> = impacted
        .iter()
        .map(|project| (*project, BTreeSet::from([*project])))
        .collect();
    let mut queue: VecDeque<&'a str> = impacted.iter().copied().collect();
    while let Some(changed_project) = queue.pop_front() {
        let inherited = origins.get(changed_project).cloned().unwrap_or_default();
        for candidate in &manifest.projects {
            if !candidate
                .fallback_dependencies
                .iter()
                .any(|dependency| dependency == changed_project)
            {
                continue;
            }
            let candidate_origins = origins.entry(candidate.id.as_str()).or_default();
            let mut gained_origin = false;
            for origin in &inherited {
                // Every origin must be recorded, so this cannot short-circuit on the first new one.
                gained_origin |= candidate_origins.insert(origin);
            }
            if impacted.insert(candidate.id.as_str()) || gained_origin {
                queue.push_back(candidate.id.as_str());
            }
        }
    }
    origins
}

fn add_prerequisites<'a>(
    tasks: &BTreeMap<&'a str, &'a DeclaredTask>,
    selected: &mut BTreeSet<&'a str>,
) -> Result<(), TestingError> {
    let mut queue: VecDeque<&str> = selected.iter().copied().collect();
    while let Some(id) = queue.pop_front() {
        let task = tasks
            .get(id)
            .ok_or_else(|| message(format!("Unknown task {id}.")))?;
        for dependency in &task.depends_on {
            if selected.insert(dependency.as_str()) {
                queue.push_back(dependency);
            }
        }
    }
    Ok(())
}
