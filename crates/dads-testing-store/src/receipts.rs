//! Crash-safe content-hashed task receipt store persisted under Git metadata.
//!
//! Implements the exact invalidation rules verified in `specs/dad-test/snapshot_store.qnt`:
//! - Keys hash receipt version, task id, project id, exact command/args/cwd/shell, selected files,
//!   manifest contents, workspace policy files, declared `impact_paths`, `extra_files`, and every
//!   regular file inside the planner-computed project roots and matched impact paths.
//! - Any symlink inside an input tree, unreadable file, or corrupt receipt fails closed (cache
//!   miss / no caching).
//! - Only passing executions (`exit_code == 0`) are persisted, via atomic temp-file + rename.

use crate::cache_dir::write_file_atomically;
use crate::git_state::git_dir;
use crate::receipt_cache::{FileDigestEntry, RunMemoCache};
use crate::receipt_inputs::collect_receipt_input_files;
use crate::remote_receipts::RemoteReceiptClient;
use dads_testing_core::{TaskOutput, TaskReceiptEntry, TaskReceiptRequest, TaskReceiptStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

const RECEIPT_SCHEMA_VERSION: u32 = 1;
const RECEIPT_KEY_DOMAIN: &[u8] = b"dads-testing-receipt-v5\0";
const AMBIENT_RUNTIME_ENV_KEYS: &[&str] = &["TZ", "NODE_ENV", "NODE_OPTIONS", "LC_ALL", "LANG"];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredReceipt {
    schema_version: u32,
    key: String,
    passed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stdout: Option<TaskOutput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stderr: Option<TaskOutput>,
}

pub struct FileReceiptStore {
    receipts_dir: PathBuf,
    remote: Option<RemoteReceiptClient>,
    memo: RunMemoCache,
}

impl FileReceiptStore {
    /// Resolves `<git-dir>/dads-testing/receipts/v1` for `workspace_root`, returning `None` if
    /// `workspace_root` is not inside a Git repository.
    pub fn for_workspace(workspace_root: &Path) -> Option<Self> {
        let canonical = fs::canonicalize(workspace_root).ok()?;
        let git_metadata = git_dir(&canonical)?;
        Some(Self {
            receipts_dir: git_metadata
                .join("dads-testing")
                .join("receipts")
                .join(format!("v{RECEIPT_SCHEMA_VERSION}")),
            remote: None,
            memo: RunMemoCache::default(),
        })
    }

    /// Resolves `<cache_dir>/receipts/v1` for an explicit local disk cache directory shared across
    /// worktrees or local agents.
    pub fn for_cache_dir(cache_dir: &Path) -> Self {
        Self {
            receipts_dir: cache_dir
                .join("receipts")
                .join(format!("v{RECEIPT_SCHEMA_VERSION}")),
            remote: None,
            memo: RunMemoCache::default(),
        }
    }

    /// Attaches an optional L2 remote receipt store (`file://`, `http://`, or `https://`).
    /// Unrecognized URL schemes are ignored fail-closed (L1-only).
    #[must_use]
    pub fn with_remote_url(mut self, url: &str, token: Option<String>) -> Self {
        self.remote = RemoteReceiptClient::from_url(url, token);
        self
    }

    #[cfg(test)]
    pub(crate) fn receipts_dir(&self) -> &Path {
        &self.receipts_dir
    }

    #[cfg(test)]
    pub(crate) fn in_directory(receipts_dir: PathBuf) -> Self {
        Self {
            receipts_dir,
            remote: None,
            memo: RunMemoCache::default(),
        }
    }

    fn receipt_path(&self, key: &str) -> Option<PathBuf> {
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        Some(self.receipts_dir.join(format!("{key}.json")))
    }

    fn write_l1(&self, key: &str, bytes: &[u8]) {
        let Some(final_path) = self.receipt_path(key) else {
            return;
        };
        write_file_atomically(&self.receipts_dir, key, &final_path, bytes);
    }
}

impl TaskReceiptStore for FileReceiptStore {
    fn begin_run(&self) {
        self.memo.clear();
        if let Some(remote) = &self.remote {
            remote.begin_run();
        }
    }

    fn compute_key(&self, request: &TaskReceiptRequest<'_>) -> Option<String> {
        let mut hasher = Sha256::new();
        hasher.update(RECEIPT_KEY_DOMAIN);
        hash_field(&mut hasher, "runtime", runtime_fingerprint().as_bytes());
        hash_field(&mut hasher, "task", request.task_id.as_bytes());
        hash_field(&mut hasher, "project", request.project.as_bytes());
        hash_field(&mut hasher, "executable", request.executable.as_bytes());
        for arg in request.args {
            hash_field(&mut hasher, "arg", arg.as_bytes());
        }
        hash_field(
            &mut hasher,
            "cwd",
            request.cwd.unwrap_or_default().as_bytes(),
        );
        hash_field(
            &mut hasher,
            "shell",
            if request.shell { b"1" } else { b"0" },
        );
        for (env_key, env_value) in request.env {
            hash_field(&mut hasher, "env_key", env_key.as_bytes());
            hash_field(&mut hasher, "env_val", env_value.as_bytes());
        }
        for key in AMBIENT_RUNTIME_ENV_KEYS {
            if !request.env.contains_key(*key) {
                hash_field(&mut hasher, "ambient_env_key", key.as_bytes());
                let val = std::env::var(key).ok();
                hash_field(
                    &mut hasher,
                    "ambient_env_val",
                    val.as_deref().unwrap_or("").as_bytes(),
                );
            }
        }
        for file in request.selected_files {
            hash_field(&mut hasher, "selected", file.as_bytes());
        }
        for impact_path in request.impact_paths {
            hash_field(&mut hasher, "impact_path", impact_path.as_bytes());
        }
        let manifest_bytes = self.memo.manifest_bytes(request.manifest_path)?;
        hash_field(&mut hasher, "manifest", &manifest_bytes);

        let collected = collect_receipt_input_files(request, &self.memo)?;
        for missing in collected.missing_extra_files {
            hash_field(&mut hasher, "extra_missing", missing.as_bytes());
        }
        for rel_path in collected.files {
            let full = request.workspace_root.join(&rel_path);
            let FileDigestEntry::Regular(digest, executable) = self.memo.file_entry(&full) else {
                return None;
            };
            hash_field(&mut hasher, "file", rel_path.as_bytes());
            hash_field(&mut hasher, "sha256", &digest);
            hash_field(&mut hasher, "exec", if executable { b"1" } else { b"0" });
        }

        Some(hex_digest(hasher.finalize()))
    }

    fn lookup(&self, key: &str) -> Option<TaskReceiptEntry> {
        let path = self.receipt_path(key)?;
        if let Ok(raw) = fs::read(&path)
            && let Some(entry) = parse_verified_receipt(&raw, key)
        {
            return Some(entry);
        }
        let remote = self.remote.as_ref()?;
        let remote_bytes = remote.get(key)?;
        let entry = parse_verified_receipt(&remote_bytes, key)?;
        self.write_l1(key, &remote_bytes);
        Some(entry)
    }

    fn record_pass(&self, key: &str, entry: &TaskReceiptEntry) {
        if self.receipt_path(key).is_none() {
            return;
        }
        let payload = StoredReceipt {
            schema_version: RECEIPT_SCHEMA_VERSION,
            key: key.to_owned(),
            passed: true,
            stdout: entry.stdout.clone(),
            stderr: entry.stderr.clone(),
        };
        let Ok(bytes) = serde_json::to_vec(&payload) else {
            return;
        };
        self.write_l1(key, &bytes);
        if let Some(remote) = &self.remote {
            remote.put(key, &bytes);
        }
    }
}

fn parse_verified_receipt(raw: &[u8], expected_key: &str) -> Option<TaskReceiptEntry> {
    let stored: StoredReceipt = serde_json::from_slice(raw).ok()?;
    if stored.schema_version != RECEIPT_SCHEMA_VERSION
        || stored.key != expected_key
        || !stored.passed
    {
        return None;
    }
    Some(TaskReceiptEntry {
        stdout: stored.stdout,
        stderr: stored.stderr,
    })
}

fn runtime_fingerprint() -> String {
    if let Ok(explicit) = std::env::var("DADS_TESTING_RUNTIME_FINGERPRINT")
        && !explicit.trim().is_empty()
    {
        return explicit;
    }
    static DETECTED: OnceLock<String> = OnceLock::new();
    DETECTED
        .get_or_init(|| {
            let node = Command::new("node")
                .arg("--version")
                .output()
                .ok()
                .filter(|out| out.status.success())
                .and_then(|out| String::from_utf8(out.stdout).ok())
                .map(|v| v.trim().to_owned())
                .unwrap_or_default();
            format!("{}-{}-{node}", std::env::consts::OS, std::env::consts::ARCH)
        })
        .clone()
}

fn hash_field(hasher: &mut Sha256, tag: &str, bytes: &[u8]) {
    hasher.update(tag.as_bytes());
    hasher.update([0]);
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
    hasher.update([0]);
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    let mut out = String::with_capacity(digest.as_ref().len() * 2);
    for byte in digest.as_ref() {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}
