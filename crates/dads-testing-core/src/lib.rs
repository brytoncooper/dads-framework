//! The language-neutral testing core: one protocol-v1 request in, one plan or run out.
//!
//! The wire contract lives in `protocol`; everything else is how the answer is reached — the
//! manifest that declares the workspace, the scope git resolves, the plan the evidence selects,
//! and the scheduler that runs it.
mod boundaries;
mod boundaries_config;
mod boundaries_index;
mod boundaries_match;
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
mod hotspots;
mod lockfile_impact;
mod lockfile_parse;
mod manifest;
mod manifest_validate;
mod plan;
mod plan_file;
mod plan_fingerprint;
mod protocol;
mod protocol_diagnose;
mod protocol_read_guard;
mod protocol_run;
pub mod receipts;
mod scheduler;
mod scope;
mod sql_impact;
mod sql_lexer;
mod sql_manifest;
mod sql_parser;
mod task_causes;
mod tsconfig_extends;
mod tsconfig_impact;
mod tsconfig_parse;

pub use boundaries_config::{
    BoundariesResult, BoundaryViolation, DepConstraint, WorkspaceBoundaries,
};
pub use execute::{
    execute_request, execute_request_with_graph, execute_request_with_graph_and_receipts,
    expanded_manifest_bytes, graph_analysis_can_change_the_plan, manifest_ignore_paths,
    manifest_project_roots, manifest_pure_factories_from_root,
    plan_file_needs_graph_for_read_guard, request_uses_read_guard,
};
pub use protocol::{
    CouplingHotspot, DiagnoseRemediation, DiagnoseResult, DiagnoseSummary, FallbackTrap,
    HotspotFile, HotspotProject, HotspotsOptions, HotspotsResult, HotspotsSummary, IssueScope,
    IssueSeverity, NativeRequest, NativeResponse, Operation, OperationResult,
    PROTOCOL_SCHEMA_VERSION, PlanCounts, PlanIssue, PlanResult, PlanShardMetadata, ReadGuardMode,
    RemediationSafety, ResolvedScope, RunCounts, RunResult, TaskCacheInputs, TaskCause,
    TaskDecision, TaskOutput, TaskReadGuardAllowlist, TaskRunResult, TaskShard, UndeclaredRead,
    WideningCulprit,
};
pub use receipts::{TaskReceiptEntry, TaskReceiptRequest, TaskReceiptStore};
pub use scope::{is_empty_tree_sha, path_matches_impact};
pub use tsconfig_extends::{
    collect_project_tsconfig_extends_allowlist, collect_tsconfig_extends_chain,
    list_tsconfig_files_in_dir,
};
pub use tsconfig_parse::{specifier_matches_alias, strip_jsonc};

#[cfg(test)]
mod tests;
