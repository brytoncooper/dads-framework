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
use crate::remote_receipts::RemoteReceiptClient;
use dads_testing_core::{TaskOutput, TaskReceiptEntry, TaskReceiptRequest, TaskReceiptStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

const RECEIPT_SCHEMA_VERSION: u32 = 1;
const RECEIPT_KEY_DOMAIN: &[u8] = b"dads-testing-receipt-v2\0";

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
    remote: Option<RemoteReceiptClient>,
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
        })
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
        if fs::create_dir_all(&self.receipts_dir).is_err() {
            return;
        }
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

impl TaskReceiptStore for FileReceiptStore {
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
    if let Some(git_files) =
        collect_git_project_files(request.workspace_root, request.project_roots)?
    {
        files.extend(git_files);
    } else {
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
    }
    Some(files)
}

fn collect_git_project_files(
    workspace_root: &Path,
    project_roots: &[String],
) -> Option<Option<BTreeSet<String>>> {
    let output = std::process::Command::new("git")
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
        return Some(None);
    };
    let mut collected = BTreeSet::new();
    for raw in output.stdout.split(|byte| *byte == 0) {
        if raw.is_empty() {
            continue;
        }
        let Ok(rel) = std::str::from_utf8(raw) else {
            return None;
        };
        if !matches_any_project_root(rel, project_roots) {
            continue;
        }
        let candidate = workspace_root.join(rel);
        let Ok(meta) = fs::symlink_metadata(&candidate) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            return None;
        }
        if meta.is_file() {
            collected.insert(rel.to_owned());
        }
    }
    Some(Some(collected))
}

fn matches_any_project_root(rel: &str, project_roots: &[String]) -> bool {
    project_roots.iter().any(|root| {
        let trimmed = root.trim().trim_matches('/');
        trimmed.is_empty()
            || trimmed == "."
            || rel == trimmed
            || rel.starts_with(&format!("{trimmed}/"))
    })
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
