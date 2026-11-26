//! Unowned-directory and uncovered non-code fallback trap detection for `dad-test diagnose`.
use crate::diagnose::WorkspaceIndex;
use crate::diagnose_remediation::{fallback_trap_remediation, is_safe_doc_or_asset};
use crate::graph::DependencyGraph;
use crate::manifest::TestingManifest;
use crate::protocol::FallbackTrap;
use crate::scope::{deepest_project_for_path, path_is_inside, path_matches_impact};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

const ROOT_POLICY_FILES: &[&str] = &[
    "dads.testing.json",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "tsconfig.json",
    "tsconfig.base.json",
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

struct TrapGroup {
    project: Option<String>,
    file_count: usize,
    sample_paths: Vec<String>,
    all_safe_docs_or_assets: bool,
}

pub(crate) fn find_fallback_traps(
    manifest: &TestingManifest,
    idx: &WorkspaceIndex<'_>,
    root: &Path,
    graph: Option<&DependencyGraph>,
) -> (usize, usize, Vec<FallbackTrap>) {
    let (mut unowned, mut uncovered) = (0, 0);
    let mut groups: BTreeMap<(String, String), TrapGroup> = BTreeMap::new();
    let non_code = &manifest.workspace.non_code_suffixes;
    for path in tracked_files(root) {
        if manifest
            .workspace
            .ignore_paths
            .iter()
            .any(|pattern| path_matches_impact(&path, pattern))
        {
            continue;
        }
        let (kind, prefix, project) = match deepest_project_for_path(&manifest.projects, &path) {
            None => {
                if is_root_policy_file(&path) {
                    continue;
                }
                unowned += 1;
                let mut s = path.split('/');
                let pref = match (s.next(), s.next()) {
                    (Some(a), Some(b)) if s.next().is_some() => format!("{a}/{b}/"),
                    (Some(a), Some(_)) => format!("{a}/"),
                    _ => "./".to_owned(),
                };
                ("unowned-directory", pref, None)
            }
            Some(p) => {
                let (Some(g), Some(&pi)) = (graph, idx.proj_by_id.get(p.id.as_str())) else {
                    continue;
                };
                let sql_ok = manifest.workspace.sql.as_ref().is_some_and(|s| {
                    s.migration_roots.iter().any(|r| path_is_inside(&path, r))
                        || s.snapshot_patterns
                            .iter()
                            .any(|sp| path.starts_with(&sp.prefix) && path.ends_with(&sp.suffix))
                });
                let skip = !idx.reach_projs.contains(&pi)
                    || g.contains_path(&path)
                    || sql_ok
                    || non_code.iter().any(|s| path.ends_with(s));
                if skip {
                    continue;
                }
                uncovered += 1;
                let ext = Path::new(&path).extension().and_then(|e| e.to_str());
                let label = ext
                    .filter(|e| !e.is_empty())
                    .map_or("(no extension)".into(), |e| format!("*.{e}"));
                (
                    "non-code-in-reachability-project",
                    format!("{label} in {}", p.id),
                    Some(p.id.clone()),
                )
            }
        };
        let entry = groups
            .entry((kind.to_owned(), prefix))
            .or_insert_with(|| TrapGroup {
                project,
                file_count: 0,
                sample_paths: Vec::new(),
                all_safe_docs_or_assets: true,
            });
        entry.file_count += 1;
        entry.all_safe_docs_or_assets &= is_safe_doc_or_asset(&path);
        if entry.sample_paths.len() < 3 {
            entry.sample_paths.push(path);
        }
    }
    let mut traps: Vec<FallbackTrap> = groups
        .into_iter()
        .map(|((kind, prefix), group)| {
            let remediation =
                fallback_trap_remediation(&kind, &prefix, group.all_safe_docs_or_assets);
            FallbackTrap {
                kind,
                prefix,
                file_count: group.file_count,
                sample_paths: group.sample_paths,
                project: group.project,
                remediation,
            }
        })
        .collect();
    traps.sort_by(|a, b| {
        b.file_count
            .cmp(&a.file_count)
            .then_with(|| (&a.kind, &a.prefix).cmp(&(&b.kind, &b.prefix)))
    });
    traps.truncate(30);
    (unowned, uncovered, traps)
}

fn is_root_policy_file(path: &str) -> bool {
    !path.contains('/') && ROOT_POLICY_FILES.contains(&path)
}

fn tracked_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    if let Ok(out) = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(root)
        .output()
        && out.status.success()
    {
        for raw in out.stdout.split(|&b| b == 0).filter(|e| !e.is_empty()) {
            if let Ok(text) = std::str::from_utf8(raw) {
                files.push(text.replace('\\', "/"));
            }
        }
        files.sort();
    }
    files
}
