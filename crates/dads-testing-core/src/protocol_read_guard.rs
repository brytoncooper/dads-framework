//! Protocol-v1 runtime read-guard wire types, split from `protocol.rs` to keep each file focused.

use serde::{Deserialize, Serialize};

/// One undeclared workspace file read observed at runtime by the V8 preload read guard.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndeclaredRead {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
}

/// Execution mode for the runtime workspace file-read tracer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadGuardMode {
    /// Fail any task with undeclared workspace reads and refuse to cache its receipt.
    Enforce,
    /// Record undeclared workspace reads on each task without failing the task.
    Audit,
}
