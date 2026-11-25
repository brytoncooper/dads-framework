//! Workspace access shared by every reader in this crate: which files are JavaScript sources, how
//! their paths are reported, how a file-level failure is recorded, and how git is consulted.

use crate::facts::JsUncertainty;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

pub(crate) fn is_javascript_path(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts")
    )
}

pub(crate) fn workspace_relative_path(workspace_root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(workspace_root)
        .ok()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

/// Lexically resolves `.` and `..` segments without touching the filesystem.
pub(crate) fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                let can_pop = matches!(out.components().next_back(), Some(Component::Normal(_)));
                if can_pop {
                    out.pop();
                } else if !out.has_root() {
                    out.push(component.as_os_str());
                }
            }
            Component::Normal(seg) => out.push(seg),
        }
    }
    out
}

/// File-level failures have no syntax to point at: the file could not be read or classified.
pub(crate) fn uncertainty(
    workspace_root: &Path,
    path: &Path,
    code: &str,
    message: String,
) -> JsUncertainty {
    JsUncertainty {
        path: workspace_relative_path(workspace_root, path).unwrap_or_default(),
        code: code.to_owned(),
        message,
        span: None,
        position: None,
    }
}

pub(crate) fn git_output(workspace_root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .args(args)
        .current_dir(workspace_root)
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}
