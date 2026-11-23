#![allow(
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines,
    clippy::unwrap_used
)]

use crate::{GraphFrontend, SnapshotAction, load_or_update};
use dads_testing_core::graph::DependencyGraph;
use dads_testing_core::{NativeRequest, Operation};
use std::fs::{create_dir_all, remove_dir_all, remove_file, write};
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::Command;

#[test]
fn deleted_file_is_reused_until_restored() {
    let root = testing_repository("deleted-file");
    let request = request(&root, None);
    let mut frontend = RecordingFrontend::default();
    let first = load_or_update(&request, &mut frontend);
    assert_eq!(first.action, SnapshotAction::InitialIndex);

    remove_file(root.join("src/file.ts")).expect("tracked file must be deleted");
    let deleted = load_or_update(&request, &mut frontend);
    assert_eq!(deleted.action, SnapshotAction::IncrementalUpdate);
    assert_eq!(
        frontend.incremental_paths.last(),
        Some(&vec!["src/file.ts".to_owned()])
    );

    let unchanged_delete = load_or_update(&request, &mut frontend);
    assert_eq!(unchanged_delete.action, SnapshotAction::Reused);

    write(root.join("src/file.ts"), "export const value = 2;\n")
        .expect("tracked file must be restored");
    let restored = load_or_update(&request, &mut frontend);
    assert_eq!(restored.action, SnapshotAction::IncrementalUpdate);
    assert_eq!(
        frontend.incremental_paths.last(),
        Some(&vec!["src/file.ts".to_owned()])
    );
    remove_dir_all(root).expect("temporary repository must be removable");
}

#[test]
fn rename_preserves_changed_paths_with_spaces_and_newlines() {
    let root = testing_repository("renamed-path");
    let request = request(&root, None);
    let mut frontend = RecordingFrontend::default();
    let first = load_or_update(&request, &mut frontend);
    assert_eq!(first.action, SnapshotAction::InitialIndex);

    let renamed = "src/ leading and trailing \n ";
    git(&root, &["mv", "src/file.ts", renamed]);
    let renamed_state = load_or_update(&request, &mut frontend);
    assert_eq!(renamed_state.action, SnapshotAction::IncrementalUpdate);
    assert_eq!(
        frontend.incremental_paths.last(),
        Some(&vec![renamed.to_owned(), "src/file.ts".to_owned()])
    );

    let unchanged_rename = load_or_update(&request, &mut frontend);
    assert_eq!(unchanged_rename.action, SnapshotAction::Reused);
    remove_dir_all(root).expect("temporary repository must be removable");
}

#[cfg(unix)]
#[test]
fn missing_descendant_of_symlink_fails_closed() {
    let root = testing_repository("symlink-descendant");
    let external = std::env::temp_dir().join(format!(
        "dads-testing-store-external-{}",
        std::process::id()
    ));
    let _ = remove_dir_all(&external);
    create_dir_all(&external).expect("external fixture directory must be created");
    remove_dir_all(root.join("src")).expect("source directory must be removed");
    symlink(&external, root.join("src")).expect("source symlink must be created");

    let request = request(&root, None);
    let mut frontend = RecordingFrontend::default();
    let result = load_or_update(&request, &mut frontend);
    assert_eq!(result.action, SnapshotAction::Fallback);
    assert_eq!(
        result.issues[0].code,
        "snapshot-noncurrent-scope-not-persisted"
    );

    remove_dir_all(root).expect("temporary repository must be removable");
    remove_dir_all(external).expect("external fixture directory must be removable");
}

#[derive(Default)]
struct RecordingFrontend {
    incremental_paths: Vec<Vec<String>>,
}

impl GraphFrontend for RecordingFrontend {
    fn frontend_version(&self) -> u32 {
        1
    }

    fn initial_index(&mut self, _request: &NativeRequest) -> Result<DependencyGraph, String> {
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

fn testing_repository(name: &str) -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("dads-testing-store-{name}-{}", std::process::id()));
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(root.join("dads.testing.json"), "{}\n").expect("testing manifest must be written");
    write(root.join("src/file.ts"), "export const value = 1;\n")
        .expect("fixture file must be written");
    git(&root, &["init"]);
    git(&root, &["config", "user.email", "testing@example.com"]);
    git(&root, &["config", "user.name", "Dads Testing"]);
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "initial"]);
    root
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
        cache: false,
        remote_cache_url: None,
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
