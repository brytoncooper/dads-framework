//! Protocol-v1 diagnose wire types, split from `protocol.rs` to keep each file focused.

use crate::protocol::IssueScope;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnoseResult {
    pub schema_version: u32,
    pub summary: DiagnoseSummary,
    pub workspace_uncertainties: Vec<WideningCulprit>,
    pub widening_culprits: Vec<WideningCulprit>,
    pub coupling_hotspots: Vec<CouplingHotspot>,
    pub fallback_traps: Vec<FallbackTrap>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemediationSafety {
    Safe,
    VerifyBeforeChanging,
    KeepWidenedUnlessVerified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnoseRemediation {
    pub safety: RemediationSafety,
    pub action: String,
    pub caution: String,
    pub verify: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnoseSummary {
    pub total_modules: usize,
    pub total_projects: usize,
    pub total_tasks: usize,
    pub total_test_files: usize,
    pub total_uncertainties: usize,
    pub whole_workspace_uncertainties: usize,
    pub unowned_tracked_files: usize,
    pub non_code_uncovered_files: usize,
    pub estimated_leaf_skip_percent: f64,
    pub potential_leaf_skip_percent: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WideningCulprit {
    pub code: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    pub scope: IssueScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub message: String,
    pub widened_projects: usize,
    pub widened_tasks: usize,
    pub widened_test_files: usize,
    pub remediation: DiagnoseRemediation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouplingHotspot {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub reached_modules: usize,
    pub reached_projects: usize,
    pub reached_test_files: usize,
    pub reached_test_percent: f64,
    pub typecheck_reached_test_files: usize,
    pub remediation: DiagnoseRemediation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackTrap {
    pub kind: String,
    pub prefix: String,
    pub file_count: usize,
    pub sample_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub remediation: DiagnoseRemediation,
}
