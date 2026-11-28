//! Wire types for `dad-test doctor`: static setup, runner-parity, and test-ownership proof.

use crate::protocol::IssueSeverity;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorFinding {
    pub code: String,
    pub severity: IssueSeverity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub message: String,
    pub fix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCounts {
    pub projects_checked: usize,
    pub test_tasks_checked: usize,
    pub test_files_checked: usize,
    pub errors: usize,
    pub warnings: usize,
    pub workspace_uncertainties: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorResult {
    pub schema_version: u32,
    pub ok: bool,
    pub counts: DoctorCounts,
    pub findings: Vec<DoctorFinding>,
}
