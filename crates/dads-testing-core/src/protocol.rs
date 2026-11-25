//! The protocol-v1 wire contract: the request the host sends, and the plan and run it gets back.
//! Every name and every `serde` attribute here is the published format, held by `wire_golden`.
pub use crate::hotspots::{
    HotspotFile, HotspotProject, HotspotsOptions, HotspotsResult, HotspotsSummary,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTOCOL_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskShard {
    pub index: u32,
    pub total: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRequest {
    pub schema_version: u32,
    pub operation: Operation,
    pub workspace_root: String,
    #[serde(default)]
    pub manifest_path: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub head: Option<String>,
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub only: bool,
    #[serde(default)]
    pub task_ids: Vec<String>,
    #[serde(default)]
    pub task_kinds: Vec<String>,
    #[serde(default)]
    pub targets: Vec<String>,
    #[serde(default)]
    pub projects: Vec<String>,
    #[serde(default)]
    pub exclude_projects: Vec<String>,
    #[serde(default)]
    pub shard: Option<TaskShard>,
    #[serde(default)]
    pub shard_weights: BTreeMap<String, f64>,
    #[serde(default)]
    pub jobs: Option<u32>,
    #[serde(default)]
    pub cache: bool,
    #[serde(default)]
    pub remote_cache_url: Option<String>,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub hotspots: Option<HotspotsOptions>,
}

impl Default for NativeRequest {
    fn default() -> Self {
        Self {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Plan,
            workspace_root: String::new(),
            manifest_path: None,
            base: None,
            head: None,
            all: false,
            only: false,
            task_ids: Vec::new(),
            task_kinds: Vec::new(),
            targets: Vec::new(),
            projects: Vec::new(),
            exclude_projects: Vec::new(),
            shard: None,
            shard_weights: BTreeMap::new(),
            jobs: None,
            cache: false,
            remote_cache_url: None,
            stream: false,
            hotspots: None,
        }
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    Plan,
    Run,
    Diagnose,
    Hotspots,
    ExpandManifest,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResponse {
    pub schema_version: u32,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<OperationResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl NativeResponse {
    pub fn failure(error: String) -> Self {
        Self {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            ok: false,
            result: None,
            error: Some(error),
        }
    }

    pub(crate) fn success(result: OperationResult) -> Self {
        Self {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            ok: true,
            result: Some(result),
            error: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub operation: String,
    pub plan: PlanResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<RunResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnose: Option<DiagnoseResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hotspots: Option<HotspotsResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanResult {
    pub schema_version: u32,
    pub scope: ResolvedScope,
    pub tasks: Vec<TaskDecision>,
    pub issues: Vec<PlanIssue>,
    pub complete: bool,
    pub counts: PlanCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedScope {
    pub kind: String,
    pub base: Option<String>,
    pub head: Option<String>,
    pub changed_paths: Vec<String>,
    pub full_fallback: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDecision {
    pub id: String,
    pub decision: String,
    pub reason: String,
    pub confidence: String,
    pub widened: bool,
    pub project: String,
    pub causes: Vec<TaskCause>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reached_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_files: Vec<String>,
}

/// The located evidence behind one task decision. Every widening reason names either the issue
/// that forced it or the project whose fallback dependency carried it.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TaskCause {
    DirectTaskInput {
        task_id: String,
    },
    PrerequisiteOf {
        task_id: String,
    },
    ChangedPath {
        path: String,
    },
    ChangedExport {
        path: String,
        symbol: String,
    },
    ReachedImport {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        line: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        column: Option<u32>,
        imported_from: String,
        symbols: Vec<String>,
    },
    Issue {
        index: usize,
    },
    FallbackDependency {
        project: String,
    },
    SqlObject {
        object: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanIssue {
    pub code: String,
    pub message: String,
    pub severity: IssueSeverity,
    pub scope: IssueScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

impl PlanIssue {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        severity: IssueSeverity,
        scope: IssueScope,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            severity,
            scope,
            path: None,
            line: None,
            column: None,
            project: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueSeverity {
    Info,
    Uncertainty,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueScope {
    Module,
    Workspace,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCounts {
    pub run: usize,
    pub skip_proven_unaffected: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub tasks: Vec<TaskRunResult>,
    pub counts: RunCounts,
    pub exit_code: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunResult {
    pub id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<TaskOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<TaskOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub cached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutput {
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCounts {
    pub executed: usize,
    pub failed: usize,
    pub blocked: usize,
    pub not_applicable: usize,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cached: usize,
}

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

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}
