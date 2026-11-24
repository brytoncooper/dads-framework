//! Per-run ephemeral memoization for receipt key hashing.
//!
//! Cleared at the start of every scheduled run (`begin_run`), so multiple tasks in the same run
//! share one `git ls-files` scan, one manifest read, and one SHA-256 digest per unique input file
//! while preserving exact fail-closed symlink and unreadable-file checks.

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, RwLock};

/// Result of querying `git ls-files` for one workspace root during a single run.
#[derive(Clone)]
pub(crate) enum GitFileInventory {
    /// Git succeeded and produced all valid UTF-8 tracked/untracked workspace-relative paths.
    Files(Arc<Vec<String>>),
    /// Git is unavailable or failed; caller may fall back to walking project roots directly.
    Unavailable,
    /// Git returned non-UTF-8 paths; caller must fail closed (skip caching).
    InvalidEncoding,
}

#[derive(Clone, Copy)]
pub(crate) enum FileDigestEntry {
    Regular([u8; 32]),
    Missing,
    NonRegularOrUnreadable,
}

#[derive(Default)]
pub(crate) struct RunMemoCache {
    manifest_bytes: RwLock<HashMap<PathBuf, Option<Arc<Vec<u8>>>>>,
    git_scan_lock: Mutex<()>,
    git_inventories: RwLock<HashMap<PathBuf, GitFileInventory>>,
    file_digests: RwLock<HashMap<PathBuf, FileDigestEntry>>,
}

impl RunMemoCache {
    pub(crate) fn clear(&self) {
        if let Ok(mut guard) = self.manifest_bytes.write() {
            guard.clear();
        }
        if let Ok(mut guard) = self.git_inventories.write() {
            guard.clear();
        }
        if let Ok(mut guard) = self.file_digests.write() {
            guard.clear();
        }
    }

    pub(crate) fn manifest_bytes(&self, manifest_path: &Path) -> Option<Arc<Vec<u8>>> {
        if let Ok(guard) = self.manifest_bytes.read()
            && let Some(cached) = guard.get(manifest_path)
        {
            return cached.clone();
        }
        let loaded = fs::read(manifest_path).ok().map(Arc::new);
        if let Ok(mut guard) = self.manifest_bytes.write() {
            guard.insert(manifest_path.to_path_buf(), loaded.clone());
        }
        loaded
    }

    pub(crate) fn git_inventory(&self, workspace_root: &Path) -> GitFileInventory {
        if let Ok(guard) = self.git_inventories.read()
            && let Some(cached) = guard.get(workspace_root)
        {
            return cached.clone();
        }
        let _single_flight = self.git_scan_lock.lock();
        if let Ok(guard) = self.git_inventories.read()
            && let Some(cached) = guard.get(workspace_root)
        {
            return cached.clone();
        }
        let computed = scan_git_files(workspace_root);
        if let Ok(mut guard) = self.git_inventories.write() {
            guard.insert(workspace_root.to_path_buf(), computed.clone());
        }
        computed
    }

    /// Inspects and hashes a file once per run, distinguishing missing files (e.g. deleted tracked
    /// paths) from symlinks or unreadable files (which must fail closed).
    pub(crate) fn file_entry(&self, path: &Path) -> FileDigestEntry {
        if let Ok(guard) = self.file_digests.read()
            && let Some(cached) = guard.get(path)
        {
            return *cached;
        }
        let computed = inspect_and_hash_file(path);
        if let Ok(mut guard) = self.file_digests.write() {
            guard.insert(path.to_path_buf(), computed);
        }
        computed
    }
}

fn scan_git_files(workspace_root: &Path) -> GitFileInventory {
    let output = Command::new("git")
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .current_dir(workspace_root)
        .output()
        .ok();
    let Some(output) = output.filter(|out| out.status.success()) else {
        return GitFileInventory::Unavailable;
    };
    let mut files = Vec::new();
    for raw in output.stdout.split(|byte| *byte == 0) {
        if raw.is_empty() {
            continue;
        }
        let Ok(rel) = std::str::from_utf8(raw) else {
            return GitFileInventory::InvalidEncoding;
        };
        files.push(rel.to_owned());
    }
    GitFileInventory::Files(Arc::new(files))
}

fn inspect_and_hash_file(path: &Path) -> FileDigestEntry {
    let metadata = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return FileDigestEntry::Missing;
        }
        Err(_) => return FileDigestEntry::NonRegularOrUnreadable,
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return FileDigestEntry::NonRegularOrUnreadable;
    }
    let Ok(bytes) = fs::read(path) else {
        return FileDigestEntry::NonRegularOrUnreadable;
    };
    let digest = Sha256::digest(&bytes);
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    FileDigestEntry::Regular(out)
}
