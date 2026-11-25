//! Protocol-v1 run-execution wire types, split from `protocol.rs` to keep each file focused.

use crate::protocol_read_guard::UndeclaredRead;
use serde::{Deserialize, Serialize};

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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub undeclared_reads: Vec<UndeclaredRead>,
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
