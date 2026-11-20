#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

use crate::git_state::GitState;
use crate::persist::persist_graph;
use crate::snapshot::{Snapshot, read_snapshot, snapshot_matches, write_snapshot_atomically};
use crate::{
    GraphFrontend, SNAPSHOT_SCHEMA_VERSION, SnapshotAction, SnapshotIdentity, load_or_update,
};
use dads_testing_core::graph::{DependencyGraph, GraphUncertainty, GraphUncertaintyScope};
use dads_testing_core::{NativeRequest, Operation};
use std::fs::{create_dir_all, read, remove_dir_all, write};
use std::path::Path;
use std::process::Command;

#[test]
fn snapshot_round_trips_and_atomic_replacement_leaves_no_partial_payload() {
    let root = std::env::temp_dir().join("dads-testing-store-atomic");
    let _ = remove_dir_all(&root);
    let path = root.join("git/dads-testing/graph-v1.json");
    let first = snapshot(&root, "one", SNAPSHOT_SCHEMA_VERSION);
    write_snapshot_atomically(&path, &first).expect("initial snapshot must be written");
    let second = snapshot(&root, "two", SNAPSHOT_SCHEMA_VERSION);
    write_snapshot_atomically(&path, &second).expect("replacement snapshot must be written");
    assert_eq!(
        read_snapshot(&path)
            .expect("snapshot must be readable")
            .expect("snapshot must exist")
            .head_sha,
        "two"
    );
    assert!(
        read(&path)
            .expect("snapshot bytes must exist")
            .starts_with(b"{")
    );
    let _ = remove_dir_all(root);
}

#[test]
fn incompatible_schema_is_rejected_before_reuse() {
    let root = std::env::temp_dir().join("dads-testing-store-version");
    let snapshot = snapshot(&root, "state", SNAPSHOT_SCHEMA_VERSION + 1);
    assert!(!snapshot_matches(&snapshot, &root, "manifest", 1));
}

#[test]
fn persists_an_uncertain_snapshot_for_unchanged_state_reuse() {
    let root = std::env::temp_dir().join("dads-testing-store-uncertain-reuse");
    let _ = remove_dir_all(&root);
    let path = root.join("git/dads-testing/graph-v1.json");
    let graph = DependencyGraph::new(
        vec![],
        vec![GraphUncertainty {
            path: "src/dynamic.ts".to_owned(),
            code: "nonliteral-dynamic-import".to_owned(),
            message: "The importer remains conservatively uncertain.".to_owned(),
            scope: GraphUncertaintyScope::WholeWorkspace,
            location: None,
        }],
    );

    let stored = persist_graph(
        &SnapshotIdentity {
            workspace: root.clone(),
            snapshot_path: path.clone(),
            manifest_digest: "manifest".to_owned(),
        },
        1,
        GitState {
            head_sha: "state".to_owned(),
            scope_signature: "base=None;head=None;all=false".to_owned(),
            changed_fingerprints: Vec::new(),
        },
        graph,
        SnapshotAction::InitialIndex,
    );
    let snapshot = read_snapshot(&path)
        .expect("snapshot must be readable")
        .expect("uncertain snapshot must be persisted");

    assert_eq!(stored.action, SnapshotAction::InitialIndex);
    assert!(snapshot_matches(&snapshot, &root, "manifest", 1));
    assert!(snapshot.graph.has_uncertainty());
    let reachable = snapshot
        .graph
        .symbol_reachability_from(["src/changed.ts".to_owned()]);
    assert!(reachable.uncertainties.iter().any(|uncertainty| {
        uncertainty.code == "nonliteral-dynamic-import"
            && uncertainty.scope == GraphUncertaintyScope::WholeWorkspace
    }));
    let _ = remove_dir_all(root);
}

#[test]
fn moved_base_ref_rebuilds_instead_of_reusing_persisted_graph() {
    let root = testing_repository("moved-base-ref");
    let base_sha = git_output(&root, &["rev-parse", "HEAD"]);
    write(root.join("src/file.ts"), "export const value = 2;\n")
        .expect("fixture file must be written");
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "current head"]);
    let head_sha = git_output(&root, &["rev-parse", "HEAD"]);
    git(
        &root,
        &["update-ref", "refs/remotes/origin/main", &base_sha],
    );

    let request = request(&root, Some("origin/main"));
    let mut frontend = RecordingFrontend::default();
    let first = load_or_update(&request, &mut frontend);
    assert_eq!(first.action, SnapshotAction::InitialIndex);
    assert_eq!(frontend.initial_indexes, 1);

    git(
        &root,
        &["update-ref", "refs/remotes/origin/main", &head_sha],
    );
    let second = load_or_update(&request, &mut frontend);

    assert_eq!(second.action, SnapshotAction::Rebuild);
    assert_eq!(frontend.initial_indexes, 2);
    assert!(frontend.incremental_paths.is_empty());
    remove_dir_all(root).expect("temporary repository must be removable");
}

#[test]
fn changed_head_with_clean_worktree_rebuilds_instead_of_zero_path_patch() {
    let root = testing_repository("changed-head");
    let request = request(&root, None);
    let mut frontend = RecordingFrontend::default();
    let first = load_or_update(&request, &mut frontend);
    assert_eq!(first.action, SnapshotAction::InitialIndex);

    write(root.join("src/file.ts"), "export const value = 2;\n")
        .expect("fixture file must be written");
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "advance head"]);
    let second = load_or_update(&request, &mut frontend);

    assert_eq!(second.action, SnapshotAction::Rebuild);
    assert_eq!(frontend.initial_indexes, 2);
    assert!(frontend.incremental_paths.is_empty());
    remove_dir_all(root).expect("temporary repository must be removable");
}

#[test]
fn unchanged_head_and_scope_incrementally_patch_changed_working_file() {
    let root = testing_repository("working-file-patch");
    let request = request(&root, None);
    let mut frontend = RecordingFrontend::default();
    let first = load_or_update(&request, &mut frontend);
    assert_eq!(first.action, SnapshotAction::InitialIndex);

    write(root.join("src/file.ts"), "export const value = 2;\n")
        .expect("fixture file must be written");
    let second = load_or_update(&request, &mut frontend);

    assert_eq!(second.action, SnapshotAction::IncrementalUpdate);
    assert_eq!(frontend.initial_indexes, 1);
    assert_eq!(
        frontend.incremental_paths,
        vec![vec!["src/file.ts".to_owned()]]
    );
    remove_dir_all(root).expect("temporary repository must be removable");
}

#[test]
fn stale_frontend_version_snapshot_is_rebuilt() {
    let root = testing_repository("stale-frontend-version");
    let request = request(&root, None);
    let mut previous_frontend = RecordingFrontend {
        version: 2,
        ..RecordingFrontend::default()
    };
    let first = load_or_update(&request, &mut previous_frontend);
    assert_eq!(first.action, SnapshotAction::InitialIndex);

    let mut current_frontend = RecordingFrontend {
        version: 3,
        ..RecordingFrontend::default()
    };
    let second = load_or_update(&request, &mut current_frontend);

    assert_eq!(second.action, SnapshotAction::Rebuild);
    assert_eq!(current_frontend.initial_indexes, 1);
    assert!(current_frontend.incremental_paths.is_empty());
    let snapshot_path = git_output(&root, &["rev-parse", "--path-format=absolute", "--git-dir"]);
    let snapshot = read_snapshot(
        &Path::new(&snapshot_path)
            .join("dads-testing")
            .join("graph-v1.json"),
    )
    .expect("snapshot must be readable")
    .expect("a rebuild must persist a snapshot");
    assert_eq!(snapshot.frontend_version, 3);
    remove_dir_all(root).expect("temporary repository must be removable");
}

/// A snapshot is keyed by what the manifest says, not by where the manifest was found. A caller
/// that regenerates the same declaration into a fresh directory on every run — which is what an
/// adapter that discovers its workspace live does — must still reuse the analysis it already has,
/// and one changed byte must still invalidate it.
#[test]
fn the_manifest_identity_is_its_contents_and_not_its_path() {
    let root = testing_repository("manifest-identity");
    let mut frontend = RecordingFrontend::default();

    let declared = load_or_update(&request(&root, None), &mut frontend);
    let same_contents_elsewhere = load_or_update(
        &manifest_request(&root, "copy/manifest.json"),
        &mut frontend,
    );
    let one_byte_apart = load_or_update(
        &manifest_request(&root, "variant/manifest.json"),
        &mut frontend,
    );

    assert_eq!(declared.action, SnapshotAction::InitialIndex);
    assert_eq!(same_contents_elsewhere.action, SnapshotAction::Reused);
    assert_eq!(one_byte_apart.action, SnapshotAction::Rebuild);
    assert_eq!(frontend.initial_indexes, 2);
    assert!(frontend.incremental_paths.is_empty());
    remove_dir_all(root).expect("temporary repository must be removable");
}

/// Two comparison bases at one head are two different analyses, not one analysis asked about
/// twice: the graph a run persists carries the change evidence its base implies, and a plan is
/// seeded from that evidence. Alternating bases must therefore rebuild, however identical the head
/// and the working tree are, or the further base would be answered with the nearer base's changed
/// exports and skip a task it has no evidence to skip.
#[test]
fn two_comparison_bases_at_one_head_never_share_a_snapshot() {
    let root = testing_repository("two-comparison-bases");
    write(root.join("src/file.ts"), "export const value = 2;\n")
        .expect("fixture file must be written");
    git(&root, &["commit", "-am", "second"]);
    write(root.join("src/file.ts"), "export const value = 3;\n")
        .expect("fixture file must be written");
    git(&root, &["commit", "-am", "third"]);
    let mut frontend = RecordingFrontend::default();

    let nearer = load_or_update(&request(&root, Some("HEAD~1")), &mut frontend);
    let further = load_or_update(&request(&root, Some("HEAD~2")), &mut frontend);
    let nearer_again = load_or_update(&request(&root, Some("HEAD~1")), &mut frontend);

    assert_eq!(nearer.action, SnapshotAction::InitialIndex);
    assert_eq!(further.action, SnapshotAction::Rebuild);
    assert_eq!(nearer_again.action, SnapshotAction::Rebuild);
    assert_eq!(frontend.initial_indexes, 3);
    assert!(frontend.incremental_paths.is_empty());
    remove_dir_all(root).expect("temporary repository must be removable");
}

/// A comparison against something other than the current head is analyzed in full and never
/// persisted. The snapshot is only ever keyed by the current head, so a snapshot written for a
/// requested head would carry a key no later run could tell apart from a current-head one.
#[test]
fn a_requested_head_is_analyzed_without_writing_a_snapshot() {
    let root = testing_repository("requested-head");
    let mut frontend = RecordingFrontend::default();

    let requested = load_or_update(
        &NativeRequest {
            head: Some("HEAD".to_owned()),
            ..request(&root, Some("HEAD"))
        },
        &mut frontend,
    );

    assert_eq!(requested.action, SnapshotAction::Fallback);
    assert_eq!(
        requested.issues[0].code,
        "snapshot-noncurrent-scope-not-persisted"
    );
    assert_eq!(frontend.initial_indexes, 1);
    let git_directory = git_output(&root, &["rev-parse", "--path-format=absolute", "--git-dir"]);
    assert!(
        read_snapshot(
            &Path::new(&git_directory)
                .join("dads-testing")
                .join("graph-v1.json")
        )
        .expect("an absent snapshot must read as absent")
        .is_none()
    );
    remove_dir_all(root).expect("temporary repository must be removable");
}

struct RecordingFrontend {
    version: u32,
    initial_indexes: usize,
    incremental_paths: Vec<Vec<String>>,
}

impl Default for RecordingFrontend {
    fn default() -> Self {
        Self {
            version: 1,
            initial_indexes: 0,
            incremental_paths: Vec::new(),
        }
    }
}

impl GraphFrontend for RecordingFrontend {
    fn frontend_version(&self) -> u32 {
        self.version
    }

    fn initial_index(&mut self, _request: &NativeRequest) -> Result<DependencyGraph, String> {
        self.initial_indexes += 1;
        Ok(DependencyGraph::default())
    }

    fn incremental_update(
        &mut self,
        _request: &NativeRequest,
        previous: DependencyGraph,
        changed_paths: &[String],
    ) -> Result<DependencyGraph, String> {
        self.incremental_paths.push(changed_paths.to_vec());
        Ok(previous)
    }
}

/// The manifest every fixture repository declares, and the same declaration one byte apart. The
/// store never parses a manifest; it only digests one, so these stand in for any two contents.
const MANIFEST: &str = "{}\n";
const MANIFEST_ONE_BYTE_APART: &str = "{ }\n";

fn testing_repository(name: &str) -> std::path::PathBuf {
    let root =
        std::env::temp_dir().join(format!("dads-testing-store-{name}-{}", std::process::id()));
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    create_dir_all(root.join("copy")).expect("fixture copy directory must be created");
    create_dir_all(root.join("variant")).expect("fixture variant directory must be created");
    write(root.join("dads.testing.json"), MANIFEST).expect("testing manifest must be written");
    write(root.join("copy/manifest.json"), MANIFEST)
        .expect("identical manifest copy must be written");
    write(root.join("variant/manifest.json"), MANIFEST_ONE_BYTE_APART)
        .expect("differing manifest must be written");
    write(root.join("src/file.ts"), "export const value = 1;\n")
        .expect("fixture file must be written");
    git(&root, &["init"]);
    git(&root, &["config", "user.email", "testing@example.com"]);
    git(&root, &["config", "user.name", "Dads Testing"]);
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "initial"]);
    root
}

fn manifest_request(root: &Path, manifest_path: &str) -> NativeRequest {
    NativeRequest {
        manifest_path: Some(manifest_path.to_owned()),
        ..request(root, None)
    }
}

fn request(root: &Path, base: Option<&str>) -> NativeRequest {
    NativeRequest {
        schema_version: 1,
        operation: Operation::Plan,
        workspace_root: root.display().to_string(),
        manifest_path: None,
        base: base.map(str::to_owned),
        head: None,
        all: false,
        task_ids: Vec::new(),
        jobs: None,
    }
}

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(root)
        .status()
        .expect("git must start");
    assert!(status.success(), "git {} must succeed", args.join(" "));
}

fn git_output(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .expect("git must start");
    assert!(
        output.status.success(),
        "git {} must succeed",
        args.join(" ")
    );
    String::from_utf8(output.stdout)
        .expect("Git output must be UTF-8")
        .trim()
        .to_owned()
}

fn snapshot(root: &std::path::Path, state: &str, schema_version: u32) -> Snapshot {
    Snapshot {
        schema_version,
        workspace_identity: root.display().to_string(),
        manifest_digest: "manifest".to_owned(),
        frontend_version: 1,
        head_sha: state.to_owned(),
        scope_signature: "base=None;head=None;all=false".to_owned(),
        changed_fingerprints: Vec::new(),
        graph: DependencyGraph::default(),
    }
}
