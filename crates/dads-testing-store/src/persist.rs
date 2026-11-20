//! Writing an analyzed graph back as the workspace's snapshot.
//!
//! Persisting is the last step and the only optional one: a graph that could not be written is
//! still returned to the caller, with the write failure recorded as an error issue.

use dads_testing_core::graph::DependencyGraph;

use crate::git_state::GitState;
use crate::issues::{failure, issue};
use crate::snapshot::{Snapshot, write_snapshot_atomically};
use crate::{SNAPSHOT_SCHEMA_VERSION, SnapshotAction, SnapshotIdentity, StoredGraph};

pub(crate) fn persist_graph(
    identity: &SnapshotIdentity,
    frontend_version: u32,
    indexed_git_state: GitState,
    graph: DependencyGraph,
    action: SnapshotAction,
) -> StoredGraph {
    let snapshot = Snapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        workspace_identity: identity.workspace.display().to_string(),
        manifest_digest: identity.manifest_digest.clone(),
        frontend_version,
        head_sha: indexed_git_state.head_sha,
        scope_signature: indexed_git_state.scope_signature,
        changed_fingerprints: indexed_git_state.changed_fingerprints,
        graph: graph.clone(),
    };
    match write_snapshot_atomically(&identity.snapshot_path, &snapshot) {
        Ok(()) => StoredGraph {
            graph: Some(graph),
            action: action.clone(),
            issues: vec![issue(persisted_code(&action), PERSISTED_MESSAGE)],
        },
        Err(error) => StoredGraph {
            graph: Some(graph),
            action: SnapshotAction::Fallback,
            issues: vec![failure(
                "graph-snapshot-write-failed",
                format!("Graph is usable for this plan but was not persisted: {error}"),
            )],
        },
    }
}

const PERSISTED_MESSAGE: &str = "Persisted graph analysis state under Git metadata.";

fn persisted_code(action: &SnapshotAction) -> &'static str {
    match action {
        SnapshotAction::InitialIndex => "graph-initial-index",
        SnapshotAction::IncrementalUpdate => "graph-incremental-update",
        SnapshotAction::Rebuild => "graph-snapshot-rebuild",
        _ => "graph-snapshot",
    }
}
