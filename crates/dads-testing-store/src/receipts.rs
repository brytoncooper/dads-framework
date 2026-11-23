//! Crash-safe content-hashed task receipt store persisted under Git metadata.
//!
//! Implements the exact invalidation rules verified in `specs/dad-test/snapshot_store.qnt`:
//! - Keys hash receipt version, task id, project id, exact command/args/cwd/shell, selected files,
//!   manifest contents, workspace policy files, and every regular file inside the task's owning
//!   project root plus its transitive `fallbackDependencies` project roots.
//! - Any symlink inside an input tree, unreadable file, or corrupt receipt fails closed (cache
//!   miss / no caching).
//! - Only passing executions (`exit_code == 0`) are persisted, via atomic temp-file + rename.

use crate::git_state::git_dir;
use dads_testing_core::{TaskOutput, TaskReceiptEntry, TaskReceiptRequest, TaskReceiptStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const RECEIPT_SCHEMA_VERSION: u32 = 1;
const RECEIPT_KEY_DOMAIN: &[u8] = b"dads-testing-receipt-v1\0";

const POLICY_FILES: &[&str] = &[
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "tsconfig.json",
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.js",
    "vitest.config.mjs",
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.js",
    "vite.config.mjs",
    "vitest.setup.ts",
    "vitest.setup.mts",
    "vitest.setup.js",
];

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "target",
    ".lake",
    "_apalache-out",
];

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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
        })
    }

    #[cfg(test)]
    pub(crate) fn receipts_dir(&self) -> &Path {
        &self.receipts_dir
    }

    #[cfg(test)]
    pub(crate) fn in_directory(receipts_dir: PathBuf) -> Self {
        Self { receipts_dir }
    }

    fn receipt_path(&self, key: &str) -> Option<PathBuf> {
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        Some(self.receipts_dir.join(format!("{key}.json")))
    }
}

impl TaskReceiptStore for FileReceiptStore {
    fn compute_key(&self, request: &TaskReceiptRequest<'_>) -> Option<String> {
        let mut hasher = Sha256::new();
        hasher.update(RECEIPT_KEY_DOMAIN);
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
        for file in request.selected_files {
            hash_field(&mut hasher, "selected", file.as_bytes());
        }
        let manifest_bytes = fs::read(request.manifest_path).ok()?;
        hash_field(&mut hasher, "manifest", &manifest_bytes);

        let files = collect_input_files(request)?;
        for rel_path in files {
            let full = request.workspace_root.join(&rel_path);
            let metadata = fs::symlink_metadata(&full).ok()?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return None;
            }
            let bytes = fs::read(&full).ok()?;
            hash_field(&mut hasher, "file", rel_path.as_bytes());
            hash_field(&mut hasher, "bytes", &bytes);
        }

        Some(hex_digest(hasher.finalize()))
    }

    fn lookup(&self, key: &str) -> Option<TaskReceiptEntry> {
        let path = self.receipt_path(key)?;
        let raw = fs::read_to_string(path).ok()?;
        let stored: StoredReceipt = serde_json::from_str(&raw).ok()?;
        if stored.schema_version != RECEIPT_SCHEMA_VERSION || stored.key != key || !stored.passed {
            return None;
        }
        Some(TaskReceiptEntry {
            stdout: stored.stdout,
            stderr: stored.stderr,
        })
    }

    fn record_pass(&self, key: &str, entry: &TaskReceiptEntry) {
        let Some(final_path) = self.receipt_path(key) else {
            return;
        };
        if fs::create_dir_all(&self.receipts_dir).is_err() {
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
        let nonce = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp_path = self
            .receipts_dir
            .join(format!(".{key}.{}.{nonce}.tmp", std::process::id()));
        if fs::write(&temp_path, bytes).is_err() {
            let _ = fs::remove_file(&temp_path);
            return;
        }
        if fs::rename(&temp_path, &final_path).is_err() {
            let _ = fs::remove_file(&temp_path);
        }
    }
}

fn collect_input_files(request: &TaskReceiptRequest<'_>) -> Option<BTreeSet<String>> {
    let mut files = BTreeSet::new();
    for policy in POLICY_FILES {
        let candidate = request.workspace_root.join(policy);
        if let Ok(meta) = fs::symlink_metadata(&candidate) {
            if meta.file_type().is_symlink() {
                return None;
            }
            if meta.is_file() {
                files.insert((*policy).to_owned());
            }
        }
    }
    for setup_file in request.setup_files {
        let candidate = request.workspace_root.join(setup_file);
        if let Ok(meta) = fs::symlink_metadata(&candidate) {
            if meta.file_type().is_symlink() {
                return None;
            }
            if meta.is_file() {
                files.insert(setup_file.clone());
            }
        }
    }
    for root in request.project_roots {
        let trimmed = root.trim().trim_end_matches('/');
        let start = if trimmed.is_empty() || trimmed == "." {
            request.workspace_root.to_path_buf()
        } else {
            request.workspace_root.join(trimmed)
        };
        if !start.exists() {
            continue;
        }
        let prefix = if trimmed.is_empty() || trimmed == "." {
            String::new()
        } else {
            trimmed.to_owned()
        };
        walk_regular_files(&start, &prefix, &mut files)?;
    }
    Some(files)
}

fn walk_regular_files(dir: &Path, prefix: &str, out: &mut BTreeSet<String>) -> Option<()> {
    let dir_meta = fs::symlink_metadata(dir).ok()?;
    if dir_meta.file_type().is_symlink() {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries {
        let entry = entry.ok()?;
        let name = entry.file_name().to_str()?.to_owned();
        if IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).ok()?;
        if meta.file_type().is_symlink() {
            return None;
        }
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        if meta.is_dir() {
            walk_regular_files(&path, &rel, out)?;
        } else if meta.is_file() {
            out.insert(rel);
        }
    }
    Some(())
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
