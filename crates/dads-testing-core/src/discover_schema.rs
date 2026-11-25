//! Schema definitions and validation for declarative `workspace.discover` manifests.

use crate::execute::{TestingError, message};
use crate::manifest::{
    FileNarrowing, ImpactMode, TaskBatchConfig, TaskExecution, TaskKind, default_true,
    validate_relative_path,
};
use crate::sql_manifest::TaskSqlImpact;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceDiscover {
    pub(crate) project_files: Vec<String>,
    #[serde(default)]
    pub(crate) exclude_roots: Vec<String>,
    #[serde(default)]
    pub(crate) named_impacts: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub(crate) target_templates: Vec<TargetTemplate>,
    #[serde(default)]
    pub(crate) task_overrides: Vec<TaskOverride>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TargetTemplate {
    pub(crate) target: String,
    pub(crate) kind: TaskKind,
    #[serde(default)]
    pub(crate) when: TargetMatch,
    pub(crate) execution: TaskExecution,
    #[serde(default)]
    pub(crate) depends_on: Vec<String>,
    #[serde(default)]
    pub(crate) depends_on_if_exists: bool,
    #[serde(default)]
    pub(crate) auto_vitest_narrowing: bool,
    #[serde(default)]
    pub(crate) auto_vitest_batching: bool,
    pub(crate) impact: TemplateImpact,
    #[serde(default)]
    pub(crate) sql_impact: Option<TaskSqlImpact>,
    #[serde(default = "default_true")]
    pub(crate) cache: bool,
}

#[derive(Debug, Default, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TargetMatch {
    #[serde(default)]
    pub(crate) file_exists: Vec<String>,
    #[serde(default)]
    pub(crate) any_file_exists: Vec<String>,
    #[serde(default)]
    pub(crate) file_not_exists: Vec<String>,
    #[serde(default)]
    pub(crate) has_target: Option<String>,
    #[serde(default)]
    pub(crate) not_target: Option<String>,
    #[serde(default)]
    pub(crate) has_tag: Option<String>,
    #[serde(default)]
    pub(crate) not_tag: Option<String>,
    #[serde(default)]
    pub(crate) root_matches: Vec<String>,
    #[serde(default)]
    pub(crate) root_excludes: Vec<String>,
    #[serde(default)]
    pub(crate) projects: Vec<String>,
    #[serde(default)]
    pub(crate) exclude_projects: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TemplateImpact {
    pub(crate) mode: ImpactMode,
    #[serde(default)]
    pub(crate) named: Vec<String>,
    #[serde(default)]
    pub(crate) paths: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskOverride {
    pub(crate) target: String,
    #[serde(default)]
    pub(crate) when: TargetMatch,
    #[serde(default)]
    pub(crate) add_named_impacts: Vec<String>,
    #[serde(default)]
    pub(crate) add_impact_paths: Vec<String>,
    #[serde(default)]
    pub(crate) env: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(default)]
    pub(crate) args: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) cache: Option<bool>,
    #[serde(default)]
    pub(crate) file_narrowing: Option<FileNarrowing>,
    #[serde(default)]
    pub(crate) batch: Option<TaskBatchConfig>,
    #[serde(default)]
    pub(crate) sql_impact: Option<TaskSqlImpact>,
}

pub(crate) fn validate_discover(discover: &WorkspaceDiscover) -> Result<(), TestingError> {
    if discover.project_files.is_empty() {
        return Err(message(
            "workspace.discover.projectFiles must declare at least one glob pattern.",
        ));
    }
    for pattern in &discover.project_files {
        validate_relative_path(pattern, "workspace.discover.projectFiles")?;
    }
    for (group, paths) in &discover.named_impacts {
        for path in paths {
            validate_relative_path(path, &format!("workspace.discover.namedImpacts.{group}"))?;
        }
    }
    for template in &discover.target_templates {
        if template.target.trim().is_empty() {
            return Err(message(
                "workspace.discover.targetTemplates[].target must not be empty.",
            ));
        }
        for group in &template.impact.named {
            if !discover.named_impacts.contains_key(group) {
                return Err(message(format!(
                    "targetTemplate '{}' references unknown namedImpact '{group}'.",
                    template.target
                )));
            }
        }
    }
    for item in &discover.task_overrides {
        for group in &item.add_named_impacts {
            if !discover.named_impacts.contains_key(group) {
                return Err(message(format!(
                    "taskOverride for '{}' references unknown namedImpact '{group}'.",
                    item.target
                )));
            }
        }
    }
    Ok(())
}
