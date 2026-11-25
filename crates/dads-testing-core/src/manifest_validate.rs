//! Validation rules for canonical `TestingManifest` declarations.

use crate::boundaries_config::validate_workspace_boundaries;
use crate::execute::{TestingError, message};
use crate::manifest::{
    DeclaredTask, FileNarrowing, ImpactMode, TaskBatchConfig, TaskExecution, TestingManifest,
    WorkspaceSettings, validate_relative_path,
};
use crate::scope::validate_dynamic_import_scopes;
use crate::sql_manifest::{validate_task_sql_impact, validate_workspace_sql};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub(crate) fn validate_manifest(
    manifest: &TestingManifest,
    _workspace_root: &Path,
) -> Result<(), TestingError> {
    validate_workspace(&manifest.workspace)?;
    let project_ids = validate_projects(manifest)?;
    let task_ids = validate_tasks(manifest, &project_ids)?;
    validate_task_dependencies(&manifest.tasks, &task_ids)?;
    validate_task_cycles(&manifest.tasks)?;
    let fallback_ids = unique_set(
        &manifest.workspace.full_fallback.task_ids,
        "fullFallback.taskIds",
    )?;
    if fallback_ids.len() != task_ids.len() || fallback_ids != task_ids {
        return Err(message(
            "workspace.fullFallback.taskIds must contain every declared task exactly once.",
        ));
    }
    if manifest.tasks.is_empty() {
        return Err(message("Manifest must declare at least one task."));
    }
    Ok(())
}

fn validate_projects(manifest: &TestingManifest) -> Result<BTreeSet<String>, TestingError> {
    let mut project_ids = BTreeSet::new();
    for project in &manifest.projects {
        require_identifier(&project.id, "project id")?;
        if !project_ids.insert(project.id.clone()) {
            return Err(message(format!("Duplicate project id {}.", project.id)));
        }
        validate_relative_path(&project.root, "project.root")?;
        for dependency in &project.fallback_dependencies {
            if dependency == &project.id {
                return Err(message(format!(
                    "Project {} cannot fallback-depend on itself.",
                    project.id
                )));
            }
        }
    }
    for project in &manifest.projects {
        for dependency in &project.fallback_dependencies {
            if !project_ids.contains(dependency) {
                return Err(message(format!(
                    "Project {} references unknown fallback dependency {}.",
                    project.id, dependency
                )));
            }
        }
    }
    Ok(project_ids)
}

fn validate_tasks(
    manifest: &TestingManifest,
    project_ids: &BTreeSet<String>,
) -> Result<BTreeSet<String>, TestingError> {
    let mut task_ids = BTreeSet::new();
    for task in &manifest.tasks {
        require_identifier(&task.id, "task id")?;
        if !task_ids.insert(task.id.clone()) {
            return Err(message(format!("Duplicate task id {}.", task.id)));
        }
        if !project_ids.contains(&task.project) {
            return Err(message(format!(
                "Task {} references unknown project {}.",
                task.id, task.project
            )));
        }
        if task.execution.executable.trim().is_empty() {
            return Err(message(format!(
                "Task {} is missing execution.executable.",
                task.id
            )));
        }
        if let Some(cwd) = &task.execution.cwd {
            validate_relative_path(cwd, "execution.cwd")?;
        }
        validate_task_env(&task.id, &task.execution.env)?;
        if let Some(narrowing) = &task.execution.file_narrowing {
            validate_file_narrowing(&task.id, narrowing)?;
        }
        if let Some(batch) = &task.execution.batch {
            validate_task_batch(&task.id, &task.execution, batch)?;
        }
        if let Some(sql_impact) = &task.sql_impact {
            validate_task_sql_impact(&task.id, sql_impact)?;
        }
        for path in &task.impact.paths {
            validate_relative_path(path, "impact.paths")?;
        }
        if task.impact.mode == ImpactMode::ChangedFiles && task.impact.paths.is_empty() {
            return Err(message(format!(
                "Task {} uses changed-files impact without paths.",
                task.id
            )));
        }
    }
    Ok(task_ids)
}

fn validate_task_dependencies(
    tasks: &[DeclaredTask],
    task_ids: &BTreeSet<String>,
) -> Result<(), TestingError> {
    for task in tasks {
        for dependency in &task.depends_on {
            if dependency == &task.id {
                return Err(message(format!(
                    "Task {} cannot depend on itself.",
                    task.id
                )));
            }
            if !task_ids.contains(dependency) {
                return Err(message(format!(
                    "Task {} references unknown dependency {}.",
                    task.id, dependency
                )));
            }
        }
    }
    Ok(())
}

fn validate_workspace(workspace: &WorkspaceSettings) -> Result<(), TestingError> {
    if let Some(root) = &workspace.root {
        validate_relative_path(root, "workspace.root")?;
    }
    if let Some(sql) = &workspace.sql {
        validate_workspace_sql(sql)?;
    }
    if let Some(boundaries) = &workspace.boundaries {
        validate_workspace_boundaries(boundaries)?;
    }
    for suffix in &workspace.non_code_suffixes {
        if !suffix.starts_with('.') || suffix.len() < 2 || suffix.contains('/') {
            return Err(message(format!(
                "workspace.nonCodeSuffixes entry '{suffix}' must be a file extension like '.md'."
            )));
        }
    }
    validate_pure_factories(&workspace.pure_factories)?;
    validate_dynamic_import_scopes(&workspace.dynamic_import_scopes)
}

pub(crate) fn validate_pure_factories(patterns: &[String]) -> Result<(), TestingError> {
    for pattern in patterns {
        if !is_valid_pure_factory_pattern(pattern) {
            return Err(message(format!(
                "workspace.pureFactories entry '{pattern}' must be an identifier chain like 'pgTable', 'React.memo', or 'z.*'."
            )));
        }
    }
    Ok(())
}

fn is_valid_pure_factory_pattern(pattern: &str) -> bool {
    if pattern.is_empty() {
        return false;
    }
    let body = pattern.strip_suffix(".*").unwrap_or(pattern);
    !body.is_empty() && body.split('.').all(is_js_identifier_segment)
}

fn is_js_identifier_segment(segment: &str) -> bool {
    let mut chars = segment.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || matches!(first, '_' | '$'))
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$'))
}

fn validate_task_env(task_id: &str, env: &BTreeMap<String, String>) -> Result<(), TestingError> {
    for (key, value) in env {
        if key.is_empty() || key.contains('=') || key.contains('\0') {
            return Err(message(format!(
                "Task {task_id} has invalid execution.env key '{key}'."
            )));
        }
        if value.contains('\0') {
            return Err(message(format!(
                "Task {task_id} has invalid execution.env value for '{key}'."
            )));
        }
    }
    Ok(())
}

fn validate_task_batch(
    task_id: &str,
    execution: &TaskExecution,
    batch: &TaskBatchConfig,
) -> Result<(), TestingError> {
    if batch.max_size < 2 {
        return Err(message(format!(
            "Task {task_id} execution.batch.maxSize must be at least 2."
        )));
    }
    if execution.shell {
        return Err(message(format!(
            "Task {task_id} cannot combine execution.batch with execution.shell."
        )));
    }
    if let Some(shared_args) = batch.shared_args
        && shared_args > execution.args.len()
    {
        return Err(message(format!(
            "Task {task_id} execution.batch.sharedArgs ({shared_args}) exceeds execution.args length ({}).",
            execution.args.len()
        )));
    }
    Ok(())
}

fn validate_file_narrowing(task_id: &str, narrowing: &FileNarrowing) -> Result<(), TestingError> {
    if narrowing.suffixes.is_empty() {
        return Err(message(format!(
            "Task {task_id} uses execution.fileNarrowing without suffixes."
        )));
    }
    for setup_file in &narrowing.setup_files {
        validate_relative_path(setup_file, "execution.fileNarrowing.setupFiles")?;
    }
    Ok(())
}

fn validate_task_cycles(tasks: &[DeclaredTask]) -> Result<(), TestingError> {
    let task_map: BTreeMap<&str, &DeclaredTask> =
        tasks.iter().map(|task| (task.id.as_str(), task)).collect();
    let mut active = BTreeSet::new();
    let mut complete = BTreeSet::new();
    for task in tasks {
        visit_task(task.id.as_str(), &task_map, &mut active, &mut complete)?;
    }
    Ok(())
}

fn visit_task<'a>(
    id: &'a str,
    tasks: &BTreeMap<&'a str, &'a DeclaredTask>,
    active: &mut BTreeSet<&'a str>,
    complete: &mut BTreeSet<&'a str>,
) -> Result<(), TestingError> {
    if complete.contains(id) {
        return Ok(());
    }
    if !active.insert(id) {
        return Err(message(format!("Task dependency cycle includes {id}.")));
    }
    let task = tasks
        .get(id)
        .ok_or_else(|| message(format!("Unknown task {id}.")))?;
    for dependency in &task.depends_on {
        visit_task(dependency, tasks, active, complete)?;
    }
    active.remove(id);
    complete.insert(id);
    Ok(())
}

fn require_identifier(value: &str, field: &str) -> Result<(), TestingError> {
    if value.is_empty()
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
    {
        return Err(message(format!(
            "{field} must use letters, numbers, -, _, ., or :."
        )));
    }
    Ok(())
}

fn unique_set(values: &[String], field: &str) -> Result<BTreeSet<String>, TestingError> {
    let set: BTreeSet<String> = values.iter().cloned().collect();
    if set.len() != values.len() {
        return Err(message(format!("{field} contains duplicate task ids.")));
    }
    Ok(set)
}
