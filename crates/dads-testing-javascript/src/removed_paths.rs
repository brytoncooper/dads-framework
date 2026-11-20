use crate::workspace::{git_output, is_javascript_path};
use std::path::Path;

pub(crate) fn removed_javascript_path_exists(workspace_root: &Path) -> Option<bool> {
    // Every rename exposes its absent source path when rename detection is disabled. NUL
    // delimiters preserve tabs and newlines instead of interpreting filenames as diff syntax.
    // Compare to the indexed HEAD, not an older request base that may predate the removed module.
    let deleted = git_output(
        workspace_root,
        &[
            "diff",
            "--name-only",
            "--diff-filter=D",
            "--no-renames",
            "-z",
            "HEAD",
            "--",
        ],
    )?;
    let paths = std::str::from_utf8(&deleted).ok()?;
    Some(
        paths
            .split('\0')
            .any(|path| is_javascript_path(Path::new(path))),
    )
}
