//! Runtime workspace file-read guard lifecycle, `NODE_OPTIONS` preload injection, JSONL report
//! parsing, and actionable failure diagnostics.

use super::read_guard_allowlist::TaskReadGuardAllowlist;
use crate::execute::{TestingError, message};
use crate::manifest::{TaskExecution, TaskKind};
use crate::protocol::{ReadGuardMode, TaskOutput, TaskRunResult, UndeclaredRead};
use crate::tsconfig_extends::collect_project_tsconfig_extends_allowlist;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const EMBEDDED_READ_GUARD_HELPERS: &str = include_str!("read_guard_helpers.mjs");
const EMBEDDED_READ_GUARD_HOOK: &str = include_str!("read_guard.mjs");
const CONFIG_ENV_KEY: &str = "DADS_TEST_READ_GUARD_CONFIG";
const NODE_OPTIONS_KEY: &str = "NODE_OPTIONS";

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Shared session state for one `run_plan` execution when read guard is enabled.
///
/// Materializes the embedded V8 preload hook once for the entire run and cleans it up on drop.
pub(super) struct ReadGuardSession {
    mode: ReadGuardMode,
    workspace_root: PathBuf,
    workspace_root_raw: PathBuf,
    hook_file_url: String,
    _hook_temp_guard: Option<TempDirGuard>,
}

/// Per-process temporary config and JSONL report guards for one spawned task invocation.
pub(super) struct ReadGuardInvocation {
    report_path: PathBuf,
    _config_guard: TempFileGuard,
    _report_guard: TempFileGuard,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HookConfig<'a> {
    mode: &'static str,
    workspace_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_root_raw: Option<String>,
    report_path: String,
    allowed_project_roots: &'a [String],
    allowed_impact_paths: &'a [String],
    allowed_extra_files: &'a [String],
    allowed_ancestor_dirs: &'a [String],
}

impl ReadGuardSession {
    pub(super) fn start(
        mode: ReadGuardMode,
        workspace_root: &Path,
        workspace_root_raw: &Path,
        hook_path_override: Option<&str>,
    ) -> Result<Self, TestingError> {
        let (hook_path, guard) = match hook_path_override {
            Some(override_path) => {
                let path = PathBuf::from(override_path);
                if !path.is_file() {
                    return Err(message(format!(
                        "readGuardHookPath does not point to a file: {}",
                        path.display()
                    )));
                }
                (path, None)
            }
            None => {
                let seq = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let dir = std::env::temp_dir()
                    .join(format!("dads-read-guard-{}-{seq}", std::process::id()));
                fs::create_dir_all(&dir).map_err(|error| {
                    message(format!(
                        "Unable to create read-guard hook dir {}: {error}",
                        dir.display()
                    ))
                })?;
                let helpers_path = dir.join("read_guard_helpers.mjs");
                let path = dir.join("read_guard.mjs");
                fs::write(&helpers_path, EMBEDDED_READ_GUARD_HELPERS).map_err(|error| {
                    message(format!(
                        "Unable to write read-guard helpers {}: {error}",
                        helpers_path.display()
                    ))
                })?;
                fs::write(&path, EMBEDDED_READ_GUARD_HOOK).map_err(|error| {
                    message(format!(
                        "Unable to write read-guard hook {}: {error}",
                        path.display()
                    ))
                })?;
                (path, Some(TempDirGuard(dir)))
            }
        };
        let hook_file_url = path_to_file_url(&hook_path);
        Ok(Self {
            mode,
            workspace_root: workspace_root.to_path_buf(),
            workspace_root_raw: workspace_root_raw.to_path_buf(),
            hook_file_url,
            _hook_temp_guard: guard,
        })
    }

    pub(super) fn mode(&self) -> ReadGuardMode {
        self.mode
    }

    pub(super) fn prepare_invocation(
        &self,
        worker_id: usize,
        allowlist: &TaskReadGuardAllowlist,
        execution: &mut TaskExecution,
    ) -> Result<ReadGuardInvocation, String> {
        let seq = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let temp_dir = std::env::temp_dir();
        let config_path = temp_dir.join(format!("dads-rg-cfg-{pid}-{worker_id}-{seq}.json"));
        let report_path = temp_dir.join(format!("dads-rg-rep-{pid}-{worker_id}-{seq}.jsonl"));

        let canonical_str = self.workspace_root.to_string_lossy().into_owned();
        let raw_str = self.workspace_root_raw.to_string_lossy().into_owned();
        let workspace_root_raw = (raw_str != canonical_str).then_some(raw_str);

        let mut allowed_extra_files = allowlist.allowed_extra_files.clone();
        for extended in collect_project_tsconfig_extends_allowlist(
            &self.workspace_root,
            &allowlist.allowed_project_roots,
        ) {
            if !allowed_extra_files.contains(&extended) {
                allowed_extra_files.push(extended);
            }
        }

        let payload = HookConfig {
            mode: match self.mode {
                ReadGuardMode::Enforce => "enforce",
                ReadGuardMode::Audit => "audit",
            },
            workspace_root: canonical_str,
            workspace_root_raw,
            report_path: report_path.to_string_lossy().into_owned(),
            allowed_project_roots: &allowlist.allowed_project_roots,
            allowed_impact_paths: &allowlist.allowed_impact_paths,
            allowed_extra_files: &allowed_extra_files,
            allowed_ancestor_dirs: &allowlist.allowed_ancestor_dirs,
        };
        let encoded = serde_json::to_vec(&payload)
            .map_err(|error| format!("Unable to serialize read-guard config: {error}"))?;
        fs::write(&config_path, encoded)
            .map_err(|error| format!("Unable to write read-guard config: {error}"))?;

        let import_flag = format!("--import={}", self.hook_file_url);
        let existing_node_options = execution
            .env
            .get(NODE_OPTIONS_KEY)
            .cloned()
            .or_else(|| std::env::var(NODE_OPTIONS_KEY).ok())
            .unwrap_or_default();
        let merged_node_options = if existing_node_options.trim().is_empty() {
            import_flag
        } else {
            format!("{existing_node_options} {import_flag}")
        };
        execution
            .env
            .insert(NODE_OPTIONS_KEY.to_owned(), merged_node_options);
        execution.env.insert(
            CONFIG_ENV_KEY.to_owned(),
            config_path.to_string_lossy().into_owned(),
        );

        Ok(ReadGuardInvocation {
            report_path: report_path.clone(),
            _config_guard: TempFileGuard(config_path),
            _report_guard: TempFileGuard(report_path),
        })
    }
}

impl ReadGuardInvocation {
    pub(super) fn collect_violations(self) -> Vec<UndeclaredRead> {
        let Ok(contents) = fs::read_to_string(&self.report_path) else {
            return Vec::new();
        };
        let mut by_path: BTreeMap<String, UndeclaredRead> = BTreeMap::new();
        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(parsed) = serde_json::from_str::<UndeclaredRead>(trimmed) else {
                continue;
            };
            if parsed.path.is_empty() {
                continue;
            }
            by_path
                .entry(parsed.path.clone())
                .and_modify(|existing| {
                    if existing.location.is_none() && parsed.location.is_some() {
                        existing.location = parsed.location.clone();
                    }
                    if existing.api.is_none() && parsed.api.is_some() {
                        existing.api = parsed.api.clone();
                    }
                })
                .or_insert(parsed);
        }
        by_path.into_values().collect()
    }
}

/// Only inject the V8 preload hook on `TaskKind::Test` tasks that invoke a Node-compatible
/// executable so non-Node commands (`oxlint`, `tsc`, native binaries) are never affected.
pub(super) fn should_guard_task(kind: &TaskKind, execution: &TaskExecution) -> bool {
    if *kind != TaskKind::Test {
        return false;
    }
    let token = if execution.shell {
        execution
            .executable
            .split_whitespace()
            .next()
            .unwrap_or_default()
    } else {
        execution.executable.as_str()
    };
    is_node_compatible_executable(token)
}

fn is_node_compatible_executable(raw: &str) -> bool {
    let trimmed = raw.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return false;
    }
    let filename = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(trimmed)
        .to_ascii_lowercase();
    if matches!(
        filename.rsplit_once('.'),
        Some((_, "js" | "mjs" | "cjs" | "ts" | "mts" | "cts"))
    ) {
        return true;
    }
    let stem = filename
        .strip_suffix(".exe")
        .or_else(|| filename.strip_suffix(".cmd"))
        .or_else(|| filename.strip_suffix(".bat"))
        .or_else(|| filename.strip_suffix(".ps1"))
        .unwrap_or(&filename);
    matches!(
        stem,
        "node" | "nodejs" | "npx" | "npm" | "pnpm" | "yarn" | "vitest" | "tsx" | "ts-node" | "jest"
    )
}

/// Applies observed undeclared workspace reads to a completed `TaskRunResult`.
pub(super) fn apply_read_guard_result(
    result: &mut TaskRunResult,
    mode: ReadGuardMode,
    violations: Vec<UndeclaredRead>,
) {
    if violations.is_empty() {
        return;
    }
    if mode == ReadGuardMode::Enforce {
        let block = format_undeclared_reads_diagnostic(&result.id, &violations);
        result.status = "failed".into();
        result.exit_code = result.exit_code.filter(|&code| code != 0).or(Some(1));
        match &mut result.stderr {
            Some(existing) => {
                if !existing.text.ends_with('\n') && !existing.text.is_empty() {
                    existing.text.push('\n');
                }
                existing.text.push_str(&block);
            }
            None => {
                result.stderr = Some(TaskOutput {
                    text: block,
                    truncated: false,
                });
            }
        }
    }
    result.undeclared_reads = violations;
}

fn format_undeclared_reads_diagnostic(task_id: &str, violations: &[UndeclaredRead]) -> String {
    let mut out = format!("UNDECLARED WORKSPACE READS in {task_id}:\n");
    for item in violations {
        match item.location.as_deref() {
            Some(location) => {
                let _ = writeln!(out, "  - {}  (read at {location})", item.path);
            }
            None => {
                let _ = writeln!(out, "  - {}", item.path);
            }
        }
    }
    let fix_paths = format_fix_path_list(violations);
    let _ = writeln!(
        out,
        "Fix: add {fix_paths} to {task_id} impact.paths, or run `npx dad-test audit --fix --task {task_id}`."
    );
    out
}

fn format_fix_path_list(violations: &[UndeclaredRead]) -> String {
    const MAX_LISTED: usize = 5;
    let listed: Vec<String> = violations
        .iter()
        .take(MAX_LISTED)
        .map(|item| format!("\"{}\"", item.path))
        .collect();
    if violations.len() <= MAX_LISTED {
        listed.join(", ")
    } else {
        format!(
            "{} (and {} more)",
            listed.join(", "),
            violations.len() - MAX_LISTED
        )
    }
}

fn path_to_file_url(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let mut encoded = String::with_capacity(raw.len() + 16);
    if raw.starts_with('/') {
        encoded.push_str("file://");
    } else {
        encoded.push_str("file:///");
    }
    for (idx, byte) in raw.bytes().enumerate() {
        let is_windows_drive_colon = byte == b':' && idx == 1 && !raw.starts_with('/');
        let is_unreserved = byte.is_ascii_alphanumeric()
            || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~')
            || is_windows_drive_colon;
        if is_unreserved {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}
