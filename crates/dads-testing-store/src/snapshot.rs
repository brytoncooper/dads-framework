//! The persisted snapshot: its shape, the digests that decide whether it may be trusted, and the
//! reads and writes that keep it whole.
//!
//! A snapshot is only ever reused when every identity field still matches the workspace it was
//! written for, so a stale or foreign snapshot is rebuilt rather than believed.

use dads_testing_core::graph::DependencyGraph;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

use crate::SNAPSHOT_SCHEMA_VERSION;

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Snapshot {
    pub(crate) schema_version: u32,
    pub(crate) workspace_identity: String,
    pub(crate) manifest_digest: String,
    pub(crate) frontend_version: u32,
    pub(crate) head_sha: String,
    pub(crate) scope_signature: String,
    pub(crate) changed_fingerprints: Vec<ChangedFingerprint>,
    pub(crate) graph: DependencyGraph,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub(crate) struct ChangedFingerprint {
    pub(crate) path: String,
    pub(crate) digest: String,
}

pub(crate) fn read_snapshot(path: &Path) -> Result<Option<Snapshot>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

pub(crate) fn write_snapshot_atomically(path: &Path, snapshot: &Snapshot) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Snapshot path has no parent.".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".graph-v1-{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec(snapshot).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

pub(crate) fn snapshot_matches(
    snapshot: &Snapshot,
    workspace: &Path,
    manifest_digest: &str,
    frontend_version: u32,
) -> bool {
    snapshot.schema_version == SNAPSHOT_SCHEMA_VERSION
        && snapshot.workspace_identity == workspace.display().to_string()
        && snapshot.manifest_digest == manifest_digest
        && snapshot.frontend_version == frontend_version
}

pub(crate) fn manifest_digest(workspace: &Path, manifest: Option<&str>) -> Option<String> {
    let relative = Path::new(manifest.unwrap_or("dads.testing.json"));
    if relative.is_absolute()
        || relative.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return None;
    }
    let resolved = workspace.join(relative).canonicalize().ok()?;
    if !resolved.starts_with(workspace) || !resolved.is_file() {
        return None;
    }
    fs::read(resolved).ok().map(|bytes| stable_digest(&bytes))
}

pub(crate) fn stable_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub(crate) fn patchable_paths(
    previous: &[ChangedFingerprint],
    current: &[ChangedFingerprint],
) -> Option<Vec<String>> {
    let mut paths = previous.iter().map(|x| x.path.clone()).collect::<Vec<_>>();
    paths.extend(current.iter().map(|x| x.path.clone()));
    paths.sort();
    paths.dedup();
    Some(paths)
}
