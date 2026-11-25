//! Configuration schema for native module-boundary enforcement (`workspace.boundaries` in
//! `dads.testing.json` or a standalone `--config <path>` JSON file).

use crate::execute::{TestingError, message};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Default, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceBoundaries {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dep_constraints: Vec<DepConstraint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub allow_circular_self_dependency: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub enforce_buildable_lib_dependency: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub check_nested_imports: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub ban_transitive_dependencies: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ignore_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude_projects: Vec<String>,
}

#[derive(Debug, Default, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DepConstraint {
    pub source_tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only_depend_on_libs_with_tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_depend_on_libs_with_tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub banned_external_imports: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_external_imports: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundariesResult {
    pub schema_version: u32,
    pub checked_files: usize,
    pub total_projects: usize,
    pub violations: Vec<BoundaryViolation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryViolation {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub source_project: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_project: Option<String>,
    pub specifier: String,
    pub rule: String,
    pub message: String,
}

pub(crate) fn load_boundaries_config(path: &Path) -> Result<WorkspaceBoundaries, TestingError> {
    let contents = fs::read_to_string(path)
        .map_err(|error| message(format!("Unable to read {}: {error}", path.display())))?;
    let config: WorkspaceBoundaries = serde_json::from_str(&contents)
        .map_err(|error| message(format!("Invalid boundaries config {}: {error}", path.display())))?;
    validate_workspace_boundaries(&config)?;
    Ok(config)
}

pub(crate) fn validate_workspace_boundaries(
    boundaries: &WorkspaceBoundaries,
) -> Result<(), TestingError> {
    for (index, constraint) in boundaries.dep_constraints.iter().enumerate() {
        if constraint.source_tag.trim().is_empty() {
            return Err(message(format!(
                "workspace.boundaries.depConstraints[{index}].sourceTag must not be empty."
            )));
        }
        validate_optional_non_empty_strings(
            constraint.only_depend_on_libs_with_tags.as_deref(),
            &format!("workspace.boundaries.depConstraints[{index}].onlyDependOnLibsWithTags"),
        )?;
        validate_optional_non_empty_strings(
            constraint.not_depend_on_libs_with_tags.as_deref(),
            &format!("workspace.boundaries.depConstraints[{index}].notDependOnLibsWithTags"),
        )?;
        validate_optional_non_empty_strings(
            constraint.banned_external_imports.as_deref(),
            &format!("workspace.boundaries.depConstraints[{index}].bannedExternalImports"),
        )?;
        validate_optional_non_empty_strings(
            constraint.allowed_external_imports.as_deref(),
            &format!("workspace.boundaries.depConstraints[{index}].allowedExternalImports"),
        )?;
    }
    validate_non_empty_strings(&boundaries.allow, "workspace.boundaries.allow")?;
    validate_non_empty_strings(&boundaries.ignore_paths, "workspace.boundaries.ignorePaths")?;
    validate_non_empty_strings(
        &boundaries.exclude_projects,
        "workspace.boundaries.excludeProjects",
    )?;
    Ok(())
}

fn validate_non_empty_strings(values: &[String], field: &str) -> Result<(), TestingError> {
    for (index, item) in values.iter().enumerate() {
        if item.trim().is_empty() {
            return Err(message(format!("{field}[{index}] must not be empty.")));
        }
    }
    Ok(())
}

fn validate_optional_non_empty_strings(
    values: Option<&[String]>,
    field: &str,
) -> Result<(), TestingError> {
    if let Some(items) = values {
        validate_non_empty_strings(items, field)?;
    }
    Ok(())
}

fn is_false(value: &bool) -> bool {
    !*value
}
