//! The language-neutral testing core: one protocol-v1 request in, one plan or run out.
//!
//! The wire contract lives in `protocol`; everything else is how the answer is reached — the
//! manifest that declares the workspace, the scope git resolves, the plan the evidence selects,
//! and the scheduler that runs it.
mod diagnose;
mod diagnose_reachability;
mod diagnose_remediation;
mod diagnose_traps;
mod discover;
mod discover_scan;
mod discover_schema;
mod discover_vitest;
mod execute;
mod git;
pub mod graph;
mod lockfile_impact;
mod lockfile_parse;
mod manifest;
mod manifest_validate;
mod plan;
mod protocol;
pub mod receipts;
mod scheduler;
mod scope;
mod sql_impact;
mod sql_lexer;
mod sql_manifest;
mod sql_parser;
mod task_causes;

pub use execute::{
    execute_request, execute_request_with_graph, execute_request_with_graph_and_receipts,
    expanded_manifest_bytes, graph_analysis_can_change_the_plan, manifest_project_roots,
};
pub use protocol::{
    CouplingHotspot, DiagnoseRemediation, DiagnoseResult, DiagnoseSummary, FallbackTrap,
    IssueScope, IssueSeverity, NativeRequest, NativeResponse, Operation, OperationResult,
    PROTOCOL_SCHEMA_VERSION, PlanCounts, PlanIssue, PlanResult, RemediationSafety, ResolvedScope,
    RunCounts, RunResult, TaskCause, TaskDecision, TaskOutput, TaskRunResult, TaskShard,
    WideningCulprit,
};
pub use receipts::{TaskReceiptEntry, TaskReceiptRequest, TaskReceiptStore};
pub use scope::is_empty_tree_sha;

#[cfg(test)]
mod tests;
