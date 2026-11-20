//! The only place the core shells out. Git answers what changed; every answer is validated as a
//! workspace-relative path before it becomes evidence.
use crate::execute::{TestingError, message};
use crate::manifest::validate_relative_path;
use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

pub(crate) fn git_changed_paths(
    workspace_root: &Path,
    args: &[&str],
) -> Result<BTreeSet<String>, TestingError> {
    let output = git_output(workspace_root, args)?;
    let values: Vec<&[u8]> = output
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .collect();
    let mut paths = BTreeSet::new();
    let mut index = 0;
    while index < values.len() {
        let status = String::from_utf8_lossy(values[index]);
        let rename_or_copy = status.starts_with('R') || status.starts_with('C');
        index += 1;
        if index >= values.len() {
            return Err(message("Git returned an incomplete name-status record."));
        }
        let first_path = normalize_git_path(values[index])?;
        paths.insert(first_path);
        index += 1;
        if rename_or_copy {
            if index >= values.len() {
                return Err(message("Git returned an incomplete rename record."));
            }
            paths.insert(normalize_git_path(values[index])?);
            index += 1;
        }
    }
    Ok(paths)
}

pub(crate) fn git_untracked_paths(workspace_root: &Path) -> Result<BTreeSet<String>, TestingError> {
    let output = git_output(
        workspace_root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    output
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(normalize_git_path)
        .collect()
}

fn normalize_git_path(value: &[u8]) -> Result<String, TestingError> {
    let value =
        std::str::from_utf8(value).map_err(|_| message("Git returned a non-UTF-8 path."))?;
    validate_relative_path(value, "Git changed path")?;
    Ok(value.replace('\\', "/"))
}

fn git_output(workspace_root: &Path, args: &[&str]) -> Result<Vec<u8>, TestingError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(workspace_root)
        .output()
        .map_err(|error| message(format!("Unable to run git: {error}")))?;
    if !output.status.success() {
        return Err(message(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output.stdout)
}

pub(crate) fn resolve_git_ref(
    workspace_root: &Path,
    reference: &str,
) -> Result<String, TestingError> {
    let output = git_output(workspace_root, &["rev-parse", "--verify", reference])?;
    let resolved = String::from_utf8(output)
        .map_err(|_| message("Git returned a non-UTF-8 ref."))?
        .trim()
        .to_owned();
    Ok(resolved)
}
