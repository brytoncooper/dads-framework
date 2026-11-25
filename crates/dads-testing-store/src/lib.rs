//! Durable, versioned analysis state. This stores graph facts only; never test results or parser
//! state, and it lives under Git metadata so it cannot appear as a source-tree change.
//!
//! One run is four steps: establish the workspace identity a snapshot is keyed by, read whatever
//! snapshot that identity already has, choose what the snapshot allows this run to do, and persist
//! the result. `load_or_update` is the orchestration of those four; each step lives in its own
//! module or its own named function.

use dads_testing_core::NativeRequest;
use dads_testing_core::graph::DependencyGraph;
use std::path::PathBuf;

use crate::git_state::{GitState, canonical_workspace, git_dir, indexed_git_state};
use crate::issues::{failure, fallback, fallback_with, issue};
use crate::persist::persist_graph;
use crate::snapshot::{
    Snapshot, manifest_digest, patchable_paths, read_snapshot, snapshot_matches,
};

mod cache_dir;
#[cfg(test)]
mod deleted_path_tests;
mod git_state;
mod issues;
mod persist;
mod receipt_cache;
mod receipt_inputs;
mod receipts;
#[cfg(test)]
mod receipts_tests;
mod remote_receipts;
#[cfg(test)]
mod remote_receipts_tests;
mod s3_index;
mod snapshot;
#[cfg(test)]
mod tests;

pub use crate::cache_dir::resolve_cache_dir;
pub use crate::issues::{StoreIssue, StoreIssueSeverity};
pub use crate::receipts::FileReceiptStore;

pub const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotAction {
    InitialIndex,
    IncrementalUpdate,
    Rebuild,
    Reused,
    Fallback,
}

#[derive(Debug, Clone)]
pub struct StoredGraph {
    pub graph: Option<DependencyGraph>,
    pub action: SnapshotAction,
    pub issues: Vec<StoreIssue>,
}

pub trait GraphFrontend {
    fn frontend_version(&self) -> u32;
    fn initial_index(&mut self, request: &NativeRequest) -> Result<DependencyGraph, String>;
    fn incremental_update(
        &mut self,
        request: &NativeRequest,
        previous: DependencyGraph,
        changed_paths: &[String],
    ) -> Result<DependencyGraph, String>;
}

/// The workspace facts a snapshot is keyed by, and where that snapshot lives.
pub(crate) struct SnapshotIdentity {
    pub(crate) workspace: PathBuf,
    pub(crate) snapshot_path: PathBuf,
    pub(crate) manifest_digest: String,
}

/// What the persisted snapshot allows this run to do.
enum SnapshotPlan {
    /// The snapshot still describes the workspace exactly.
    Reuse(DependencyGraph),
    /// Only working-tree files moved, so the snapshot can be patched.
    Patch {
        previous: DependencyGraph,
        changed_paths: Vec<String>,
    },
    /// A snapshot exists but cannot be trusted; `unreadable` carries the read error, when the
    /// reason it cannot be trusted is that it could not be read at all.
    Rebuild { unreadable: Option<String> },
    /// No snapshot exists yet.
    Index,
}

pub fn load_or_update<F: GraphFrontend>(request: &NativeRequest, frontend: &mut F) -> StoredGraph {
    let identity = match establish_identity(request) {
        Ok(identity) => identity,
        Err(issue) => return fallback_with(issue),
    };
    let Some(state) = indexed_git_state(&identity.workspace, request) else {
        return analyze_without_snapshot(request, frontend);
    };
    let plan = choose_snapshot_plan(&identity, &state, frontend.frontend_version());
    apply_snapshot_plan(plan, request, frontend, &identity, state)
}

/// Step one: the workspace, its Git metadata, and the manifest a snapshot is keyed by. Any one of
/// them missing means no snapshot can be trusted or written, so the run falls back.
fn establish_identity(request: &NativeRequest) -> Result<SnapshotIdentity, StoreIssue> {
    let Some(workspace) = canonical_workspace(request) else {
        return Err(failure(
            "snapshot-workspace-invalid",
            "Cannot establish canonical workspace identity.",
        ));
    };
    let Some(git_directory) = git_dir(&workspace) else {
        return Err(failure(
            "snapshot-git-metadata-unavailable",
            "Cannot locate the worktree Git metadata directory.",
        ));
    };
    let Some(digest) = manifest_digest(&workspace, request.manifest_path.as_deref()) else {
        return Err(failure(
            "snapshot-manifest-unavailable",
            "Cannot read the testing manifest for snapshot validation.",
        ));
    };
    Ok(SnapshotIdentity {
        snapshot_path: git_directory.join("dads-testing").join("graph-v1.json"),
        workspace,
        manifest_digest: digest,
    })
}

/// A comparison against something other than the current head is analyzed in full and never
/// persisted, because the snapshot is only ever keyed by the current head.
fn analyze_without_snapshot<F: GraphFrontend>(
    request: &NativeRequest,
    frontend: &mut F,
) -> StoredGraph {
    match frontend.initial_index(request) {
        Ok(graph) => StoredGraph {
            graph: Some(graph),
            action: SnapshotAction::Fallback,
            issues: vec![issue(
                "snapshot-noncurrent-scope-not-persisted",
                "Current-head comparison was analyzed without snapshot reuse.",
            )],
        },
        Err(error) => fallback("snapshot-git-state-unavailable", error),
    }
}

/// Steps two and three: read the snapshot this identity has, and decide what it allows.
fn choose_snapshot_plan(
    identity: &SnapshotIdentity,
    state: &GitState,
    frontend_version: u32,
) -> SnapshotPlan {
    match read_snapshot(&identity.snapshot_path) {
        Ok(Some(snapshot))
            if snapshot_matches(
                &snapshot,
                &identity.workspace,
                &identity.manifest_digest,
                frontend_version,
            ) =>
        {
            plan_for_trusted_snapshot(snapshot, state)
        }
        Ok(Some(_)) => SnapshotPlan::Rebuild { unreadable: None },
        Ok(None) => SnapshotPlan::Index,
        Err(error) => SnapshotPlan::Rebuild {
            unreadable: Some(error),
        },
    }
}

/// A snapshot whose identity matches is reusable as it stands when the head, the scope, and every
/// changed-path fingerprint agree; a moved head or scope forces a rebuild, and a working-tree-only
/// difference is a patch.
fn plan_for_trusted_snapshot(snapshot: Snapshot, state: &GitState) -> SnapshotPlan {
    if snapshot.head_sha == state.head_sha
        && snapshot.scope_signature == state.scope_signature
        && snapshot.changed_fingerprints == state.changed_fingerprints
    {
        return SnapshotPlan::Reuse(snapshot.graph);
    }
    if snapshot.head_sha != state.head_sha || snapshot.scope_signature != state.scope_signature {
        return SnapshotPlan::Rebuild { unreadable: None };
    }
    SnapshotPlan::Patch {
        changed_paths: patchable_paths(&snapshot.changed_fingerprints, &state.changed_fingerprints)
            .unwrap_or_default(),
        previous: snapshot.graph,
    }
}

/// Step four: run the plan through the frontend and persist whatever it produced.
fn apply_snapshot_plan<F: GraphFrontend>(
    plan: SnapshotPlan,
    request: &NativeRequest,
    frontend: &mut F,
    identity: &SnapshotIdentity,
    state: GitState,
) -> StoredGraph {
    match plan {
        SnapshotPlan::Reuse(graph) => StoredGraph {
            graph: Some(graph),
            action: SnapshotAction::Reused,
            issues: vec![issue(
                "graph-snapshot-reused",
                "Reused the validated persisted graph snapshot.",
            )],
        },
        SnapshotPlan::Patch {
            previous,
            changed_paths,
        } => match frontend.incremental_update(request, previous, &changed_paths) {
            Ok(graph) => persist(
                identity,
                frontend,
                state,
                graph,
                SnapshotAction::IncrementalUpdate,
            ),
            Err(error) => rebuild_after_failed_patch(request, frontend, identity, state, error),
        },
        SnapshotPlan::Rebuild { unreadable } => match frontend.initial_index(request) {
            Ok(graph) => persist(identity, frontend, state, graph, SnapshotAction::Rebuild),
            Err(error) => match unreadable {
                Some(read_error) => fallback(
                    "graph-snapshot-corrupt",
                    format!("{read_error}; rebuild also failed: {error}"),
                ),
                None => fallback("graph-snapshot-rebuild-failed", error),
            },
        },
        SnapshotPlan::Index => match frontend.initial_index(request) {
            Ok(graph) => persist(
                identity,
                frontend,
                state,
                graph,
                SnapshotAction::InitialIndex,
            ),
            Err(error) => fallback("graph-initial-index-failed", error),
        },
    }
}

/// A frontend that cannot patch is asked to index from scratch; only when that fails too does the
/// run fall back, reporting both failures.
fn rebuild_after_failed_patch<F: GraphFrontend>(
    request: &NativeRequest,
    frontend: &mut F,
    identity: &SnapshotIdentity,
    state: GitState,
    patch_error: String,
) -> StoredGraph {
    match frontend.initial_index(request) {
        Ok(graph) => persist(identity, frontend, state, graph, SnapshotAction::Rebuild),
        Err(rebuild_error) => fallback(
            "graph-incremental-update-failed",
            format!("{patch_error}; rebuild failed: {rebuild_error}"),
        ),
    }
}

fn persist<F: GraphFrontend>(
    identity: &SnapshotIdentity,
    frontend: &F,
    state: GitState,
    graph: DependencyGraph,
    action: SnapshotAction,
) -> StoredGraph {
    persist_graph(identity, frontend.frontend_version(), state, graph, action)
}
