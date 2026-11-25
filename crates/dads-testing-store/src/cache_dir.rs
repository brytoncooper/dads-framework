//! Cache directory path resolution (`~` expansion, relative/absolute resolution) and atomic
//! cross-process file writes for shared local disk receipt caches.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Expands a leading `~` or `~/` and resolves relative cache paths against `workspace_root`.
pub fn resolve_cache_dir(raw: &str, workspace_root: &Path) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "~" {
        return user_home_dir();
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        return Some(user_home_dir()?.join(rest));
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        Some(path)
    } else {
        Some(workspace_root.join(path))
    }
}

/// Atomically writes `bytes` to `final_path` inside `dir` via an exclusive temp file + `rename`.
/// Benign concurrent-write races (e.g. another process publishing the same content-addressed key)
/// clean up their temp file and return cleanly.
pub(crate) fn write_file_atomically(dir: &Path, key: &str, final_path: &Path, bytes: &[u8]) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let nonce = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_path = dir.join(format!(".{key}.{pid}.{nanos}.{nonce}.tmp"));
    let Ok(mut file) = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
    else {
        return;
    };
    if file.write_all(bytes).is_err() {
        drop(file);
        let _ = fs::remove_file(&temp_path);
        return;
    }
    drop(file);
    if fs::rename(&temp_path, final_path).is_err() {
        let _ = fs::remove_file(&temp_path);
    }
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}
