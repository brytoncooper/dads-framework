//! The `dads.testing.json` declaration: what a workspace says it owns, and every rule the
//! declaration must satisfy before a plan is allowed to read it.
use crate::execute::{TestingError, message};
use crate::scope::validate_dynamic_import_scopes;
use crate::sql_manifest::{
    TaskSqlImpact, WorkspaceSqlSettings, validate_task_sql_impact, validate_workspace_sql,
};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path};

/// Where a workspace declares itself when the request does not name another file.
pub(crate) const DEFAULT_MANIFEST_PATH: &str = "dads.testing.json";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TestingManifest {
    pub(crate) schema_version: u32,
    pub(crate) workspace: WorkspaceSettings,
    pub(crate) projects: Vec<Project>,
    pub(crate) tasks: Vec<DeclaredTask>,
}

impl TestingManifest {
    /// Whether any declared task decides from the dependency graph.
    ///
    /// `reachability` is the only impact mode that reads one, and every graph-derived reason and
    /// cause a decision can carry hangs off it. A manifest without such a task therefore reaches
    /// the same plan whether a graph was analyzed or not.
    pub(crate) fn declares_graph_reader(&self) -> bool {
        self.tasks
            .iter()
            .any(|task| task.impact.mode == ImpactMode::Reachability)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceSettings {
    #[serde(default)]
    pub(crate) root: Option<String>,
    pub(crate) full_fallback: FullFallback,
    #[serde(default)]
    pub(crate) sql: Option<WorkspaceSqlSettings>,
    #[serde(default)]
    pub(crate) non_code_suffixes: Vec<String>,
    #[serde(default)]
    pub(crate) dynamic_import_scopes: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FullFallback {
    pub(crate) task_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Project {
    pub(crate) id: String,
    pub(crate) root: String,
    #[serde(default)]
    pub(crate) fallback_dependencies: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeclaredTask {
    pub(crate) id: String,
    pub(crate) project: String,
    pub(crate) kind: TaskKind,
    pub(crate) execution: TaskExecution,
    #[serde(default)]
    pub(crate) depends_on: Vec<String>,
    pub(crate) impact: TaskImpact,
    #[serde(default)]
    pub(crate) sql_impact: Option<TaskSqlImpact>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum TaskKind {
    Test,
    Typecheck,
    Lint,
    Build,
    Custom,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskExecution {
    pub(crate) executable: String,
    #[serde(default)]
    pub(crate) args: Vec<String>,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(default)]
    pub(crate) shell: bool,
    #[serde(default)]
    pub(crate) env: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) file_narrowing: Option<FileNarrowing>,
}

/// Optional file-level test narrowing for an un-widened `reachability` task (for example Vitest).
/// When a task is proven un-widened and no declared `setup_files` were touched, only reached files
/// matching `suffixes` (and not `exclude_suffixes`) are appended to the task's command arguments.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileNarrowing {
    pub(crate) suffixes: Vec<String>,
    #[serde(default)]
    pub(crate) exclude_suffixes: Vec<String>,
    #[serde(default)]
    pub(crate) setup_files: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskImpact {
    pub(crate) mode: ImpactMode,
    #[serde(default)]
    pub(crate) paths: Vec<String>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ImpactMode {
    Reachability,
    ChangedFiles,
    Project,
    Always,
}

pub(crate) fn load_manifest(path: &Path) -> Result<TestingManifest, TestingError> {
    let contents = fs::read_to_string(path)
        .map_err(|error| message(format!("Unable to read {}: {error}", path.display())))?;
    let manifest: TestingManifest = serde_json::from_str(&contents)
        .map_err(|error| message(format!("Invalid dads.testing.json: {error}")))?;
    if manifest.schema_version != 1 {
        return Err(message(format!(
            "Unsupported manifest schemaVersion {}. Expected 1.",
            manifest.schema_version
        )));
    }
    Ok(manifest)
}

pub(crate) fn validate_manifest(
    manifest: &TestingManifest,
    _workspace_root: &Path,
) -> Result<(), TestingError> {
    validate_workspace(&manifest.workspace)?;
    let mut project_ids: BTreeSet<String> = BTreeSet::new();
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
    let mut task_ids: BTreeSet<String> = BTreeSet::new();
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
    for task in &manifest.tasks {
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

fn validate_workspace(workspace: &WorkspaceSettings) -> Result<(), TestingError> {
    if let Some(root) = &workspace.root {
        validate_relative_path(root, "workspace.root")?;
    }
    if let Some(sql) = &workspace.sql {
        validate_workspace_sql(sql)?;
    }
    for suffix in &workspace.non_code_suffixes {
        if !suffix.starts_with('.') || suffix.len() < 2 || suffix.contains('/') {
            return Err(message(format!(
                "workspace.nonCodeSuffixes entry '{suffix}' must be a file extension like '.md'."
            )));
        }
    }
    validate_dynamic_import_scopes(&workspace.dynamic_import_scopes)
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

/// Declared tasks in dependency-first order: every prerequisite is emitted before the task that
/// depends on it, and the manifest's own order breaks every remaining tie.
pub(crate) fn task_order(tasks: &[DeclaredTask]) -> Result<Vec<String>, TestingError> {
    let by_id: BTreeMap<&str, &DeclaredTask> =
        tasks.iter().map(|task| (task.id.as_str(), task)).collect();
    let mut visited = BTreeSet::new();
    let mut order = Vec::new();
    for task in tasks {
        append_task_order(task.id.as_str(), &by_id, &mut visited, &mut order)?;
    }
    Ok(order)
}

fn append_task_order(
    id: &str,
    tasks: &BTreeMap<&str, &DeclaredTask>,
    visited: &mut BTreeSet<String>,
    order: &mut Vec<String>,
) -> Result<(), TestingError> {
    if !visited.insert(id.to_owned()) {
        return Ok(());
    }
    let task = tasks
        .get(id)
        .ok_or_else(|| message(format!("Unknown task {id}.")))?;
    for dependency in &task.depends_on {
        append_task_order(dependency, tasks, visited, order)?;
    }
    order.push(id.to_owned());
    Ok(())
}

pub(crate) fn validate_relative_path(value: &str, field: &str) -> Result<(), TestingError> {
    if value.trim().is_empty() {
        return Err(message(format!("{field} must not be empty.")));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(message(format!(
            "{field} must be a workspace-relative path without parent traversal."
        )));
    }
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
