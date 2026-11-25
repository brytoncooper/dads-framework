//! The protocol-v1 wire contract: the request the host sends, and the plan and run it gets back.
//! Every name and every `serde` attribute here is the published format, held by `wire_golden`.
use crate::boundaries_config::BoundariesResult;
pub use crate::hotspots::{
    HotspotFile, HotspotProject, HotspotsOptions, HotspotsResult, HotspotsSummary,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTOCOL_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskShard {
    pub index: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanShardMetadata {
    pub index: u32,
    pub total: u32,
    pub weighted: bool,
    pub total_projects: usize,
    pub selected_projects: usize,
    pub total_runnable_tasks: usize,
    pub selected_runnable_tasks: usize,
    pub shard_weight: f64,
    pub total_weight: f64,
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
    pub cache_dir: Option<String>,
    #[serde(default)]
    pub remote_cache_url: Option<String>,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub plan_file: Option<String>,
    #[serde(default)]
    pub hotspots: Option<HotspotsOptions>,
    #[serde(default)]
    pub boundaries_config_path: Option<String>,
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
            cache_dir: None,
            remote_cache_url: None,
            stream: false,
            plan_file: None,
            hotspots: None,
            boundaries_config_path: None,
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
    CheckBoundaries,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundaries: Option<BoundariesResult>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanResult {
    pub schema_version: u32,
    pub scope: ResolvedScope,
    pub tasks: Vec<TaskDecision>,
    #[serde(default)]
    pub issues: Vec<PlanIssue>,
    #[serde(default)]
    pub complete: bool,
    pub counts: PlanCounts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shard: Option<PlanShardMetadata>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedScope {
    pub kind: String,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub head: Option<String>,
    #[serde(default)]
    pub changed_paths: Vec<String>,
    #[serde(default)]
    pub full_fallback: bool,
}

/// Planner-computed receipt cache inputs for one runnable task.
///
/// The planner is the single source of truth for what inputs can affect a task; the receipt cache
/// hashes strictly from this structure and fails closed whenever `cacheable` is `false` or absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCacheInputs {
    pub cacheable: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub project_roots: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub impact_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDecision {
    pub id: String,
    pub decision: String,
    pub reason: String,
    pub confidence: String,
    pub widened: bool,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub causes: Vec<TaskCause>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reached_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_inputs: Option<TaskCacheInputs>,
}

/// The located evidence behind one task decision. Every widening reason names either the issue
/// that forced it or the project whose fallback dependency carried it.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        column: Option<u32>,
        imported_from: String,
        #[serde(default)]
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanIssue {
    pub code: String,
    pub message: String,
    pub severity: IssueSeverity,
    pub scope: IssueScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueSeverity {
    Info,
    Uncertainty,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueScope {
    Module,
    Workspace,
}

#[derive(Debug, Serialize, Deserialize)]
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

pub use crate::protocol_diagnose::{
    CouplingHotspot, DiagnoseRemediation, DiagnoseResult, DiagnoseSummary, FallbackTrap,
    RemediationSafety, WideningCulprit,
};

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}
