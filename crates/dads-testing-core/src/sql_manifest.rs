//! SQL / migration manifest declarations and validation.

use crate::execute::{TestingError, message};
use crate::manifest::validate_relative_path;
use crate::sql_lexer::normalize_sql_object;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceSqlSettings {
    pub(crate) migration_roots: Vec<String>,
    #[serde(default)]
    pub(crate) objects: Vec<String>,
    #[serde(default)]
    pub(crate) edges: Vec<SqlDepEdgeConfig>,
    #[serde(default)]
    pub(crate) snapshot_patterns: Vec<SqlSnapshotPattern>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SqlDepEdgeConfig {
    pub(crate) from: String,
    pub(crate) to: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SqlSnapshotPattern {
    pub(crate) prefix: String,
    pub(crate) suffix: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskSqlImpact {
    #[serde(default)]
    pub(crate) is_migration_runner: bool,
    #[serde(default)]
    pub(crate) tables: Vec<String>,
    #[serde(default)]
    pub(crate) has_unmapped_sql: bool,
}

pub(crate) fn validate_workspace_sql(sql: &WorkspaceSqlSettings) -> Result<(), TestingError> {
    if sql.migration_roots.is_empty() && sql.snapshot_patterns.is_empty() {
        return Err(message(
            "workspace.sql must declare at least one migrationRoots or snapshotPatterns entry.",
        ));
    }
    for root in &sql.migration_roots {
        validate_relative_path(root, "workspace.sql.migrationRoots")?;
    }
    for object in &sql.objects {
        if normalize_sql_object(object).is_none() {
            return Err(message(format!(
                "workspace.sql.objects contains invalid SQL identifier '{object}'."
            )));
        }
    }
    for edge in &sql.edges {
        if normalize_sql_object(&edge.from).is_none() || normalize_sql_object(&edge.to).is_none() {
            return Err(message(format!(
                "workspace.sql.edges contains invalid SQL identifier ({} -> {}).",
                edge.from, edge.to
            )));
        }
    }
    for pattern in &sql.snapshot_patterns {
        validate_relative_path(&pattern.prefix, "workspace.sql.snapshotPatterns.prefix")?;
        if pattern.suffix.trim().is_empty() {
            return Err(message(
                "workspace.sql.snapshotPatterns.suffix must not be empty.",
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_task_sql_impact(
    task_id: &str,
    impact: &TaskSqlImpact,
) -> Result<(), TestingError> {
    for table in &impact.tables {
        if normalize_sql_object(table).is_none() {
            return Err(message(format!(
                "Task {task_id} has invalid sqlImpact.tables identifier '{table}'."
            )));
        }
    }
    Ok(())
}
