//! The protocol-v1 wire contract: the request the host sends, and the plan and run it gets back.
//! Every name and every `serde` attribute here is the published format, held by `wire_golden`.
use serde::{Deserialize, Serialize};

pub const PROTOCOL_SCHEMA_VERSION: u32 = 1;

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
    pub task_ids: Vec<String>,
    #[serde(default)]
    pub jobs: Option<u32>,
    #[serde(default)]
    pub cache: bool,
    #[serde(default)]
    pub remote_cache_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Plan,
    Run,
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

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}
