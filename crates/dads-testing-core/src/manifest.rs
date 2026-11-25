//! The `dads.testing.json` declaration: what a workspace says it owns, and every rule the
//! declaration must satisfy before a plan is allowed to read it.
use crate::boundaries_config::WorkspaceBoundaries;
use crate::discover::WorkspaceDiscover;
use crate::execute::{TestingError, message};
pub(crate) use crate::manifest_validate::validate_manifest;
use crate::sql_manifest::{TaskSqlImpact, WorkspaceSqlSettings};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path};

/// Where a workspace declares itself when the request does not name another file.
pub(crate) const DEFAULT_MANIFEST_PATH: &str = "dads.testing.json";

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TestingManifest {
    pub(crate) schema_version: u32,
    pub(crate) workspace: WorkspaceSettings,
    #[serde(default)]
    pub(crate) projects: Vec<Project>,
    #[serde(default)]
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

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) root: Option<String>,
    #[serde(default)]
    pub(crate) full_fallback: FullFallback,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) sql: Option<WorkspaceSqlSettings>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) non_code_suffixes: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) ignore_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) pure_factories: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) dynamic_import_scopes: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) discover: Option<WorkspaceDiscover>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) boundaries: Option<WorkspaceBoundaries>,
}

#[derive(Debug, Default, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FullFallback {
    #[serde(default)]
    pub(crate) task_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Project {
    pub(crate) id: String,
    pub(crate) root: String,
    #[serde(default)]
    pub(crate) fallback_dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) tags: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeclaredTask {
    pub(crate) id: String,
    pub(crate) project: String,
    pub(crate) kind: TaskKind,
    pub(crate) execution: TaskExecution,
    #[serde(default)]
    pub(crate) depends_on: Vec<String>,
    pub(crate) impact: TaskImpact,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) sql_impact: Option<TaskSqlImpact>,
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub(crate) cache: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum TaskKind {
    Test,
    Typecheck,
    Lint,
    Build,
    Custom,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskExecution {
    pub(crate) executable: String,
    #[serde(default)]
    pub(crate) args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cwd: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) shell: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) file_narrowing: Option<FileNarrowing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) batch: Option<TaskBatchConfig>,
}

/// Optional native batching configuration for commands that accept multiple project or file paths
/// in a single process invocation (for example `oxlint`, `eslint`, or narrowed `vitest` runs).
#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskBatchConfig {
    pub(crate) max_size: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) group_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) shared_args: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) mode: Option<BatchMode>,
}

impl TaskBatchConfig {
    pub(crate) fn effective_mode(&self) -> BatchMode {
        self.mode.unwrap_or(BatchMode::Args)
    }
}

/// Strategy used by the native scheduler to pack compatible tasks into a single process.
#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum BatchMode {
    /// Concatenate per-task trailing arguments (for example `oxlint` or `eslint` directories).
    Args,
    /// Combine narrowed Vitest test files into one `vitest run` with JSON report attribution.
    VitestFiles,
}

/// Optional file-level test narrowing for an un-widened `reachability` task (for example Vitest).
/// When a task is proven un-widened and no declared `setup_files` were touched, only reached files
/// matching `suffixes` (and not `exclude_suffixes`) are appended to the task's command arguments.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileNarrowing {
    pub(crate) suffixes: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) exclude_suffixes: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) setup_files: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskImpact {
    pub(crate) mode: ImpactMode,
    #[serde(default)]
    pub(crate) paths: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
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

fn is_false(value: &bool) -> bool {
    !*value
}

pub(crate) fn default_true() -> bool {
    true
}

fn is_true(value: &bool) -> bool {
    *value
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
