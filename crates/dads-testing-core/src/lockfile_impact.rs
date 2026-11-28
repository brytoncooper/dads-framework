//! Fail-closed lockfile package-diff narrowing, mirroring the machine-checked soundness proof in
//! `proofs/dad-test/DadTest/LockfileNarrowing.lean`.

use crate::graph::DependencyGraph;
use crate::lockfile_parse::{
    PackageSnapshot, is_toolchain_package, only_dependency_blocks_changed,
    parse_lockfile_v3_packages,
};
use crate::lockfile_pnpm::diff_pnpm_lockfile_v9;
use crate::protocol::{IssueScope, IssueSeverity, PlanIssue, ResolvedScope};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::Path;
use std::process::Command;

const NPM_LOCKFILE_PATH: &str = "package-lock.json";
const PNPM_LOCKFILE_PATH: &str = "pnpm-lock.yaml";
const MANIFEST_PATH: &str = "package.json";

#[derive(Debug, Default)]
pub(crate) struct LockfileImpactReport {
    pub(crate) handled_paths: BTreeSet<String>,
    pub(crate) impacted_packages: BTreeSet<String>,
    pub(crate) seeded_modules: Vec<String>,
    pub(crate) widened_importer_dirs: BTreeSet<String>,
    pub(crate) issues: Vec<PlanIssue>,
}

pub(crate) fn analyze_lockfile_impact(
    workspace_root: &Path,
    scope: &ResolvedScope,
    graph: Option<&DependencyGraph>,
) -> LockfileImpactReport {
    let mut report = LockfileImpactReport::default();
    let npm_lock_changed = scope.changed_paths.iter().any(|p| p == NPM_LOCKFILE_PATH);
    let pnpm_lock_changed = scope.changed_paths.iter().any(|p| p == PNPM_LOCKFILE_PATH);
    let pkg_changed = scope.changed_paths.iter().any(|p| p == MANIFEST_PATH);
    if !npm_lock_changed && !pnpm_lock_changed && !pkg_changed {
        return report;
    }
    if npm_lock_changed && pnpm_lock_changed {
        return report;
    }
    let (Some(graph), Some(base_ref)) = (graph, scope.base.as_deref()) else {
        return report;
    };

    if pkg_changed && !validate_manifest_change(workspace_root, base_ref, scope, &mut report) {
        return report;
    }
    let lockfile_path = if npm_lock_changed {
        NPM_LOCKFILE_PATH
    } else if pnpm_lock_changed {
        PNPM_LOCKFILE_PATH
    } else {
        return report;
    };

    let Some(base_lock) = read_git_file(workspace_root, base_ref, lockfile_path) else {
        return report;
    };
    let Some(head_lock) = read_target_file(workspace_root, scope, lockfile_path) else {
        return report;
    };
    let diff_opt = if npm_lock_changed {
        diff_lockfiles_v3(&base_lock, &head_lock)
    } else {
        diff_pnpm_lockfiles_v9(&base_lock, &head_lock)
    };
    let Some(diff) = diff_opt else {
        report.issues.push(PlanIssue {
            path: Some(lockfile_path.to_owned()),
            ..PlanIssue::new(
                "lockfile-parse-fallback",
                format!("Could not parse {lockfile_path}; keeping conservative widening."),
                IssueSeverity::Uncertainty,
                IssueScope::Workspace,
            )
        });
        return report;
    };
    if diff.must_widen {
        report.issues.push(PlanIssue {
            path: Some(lockfile_path.to_owned()),
            ..PlanIssue::new(
                "lockfile-toolchain-change",
                diff.widen_reason.unwrap_or_else(|| {
                    format!("{lockfile_path} changed a global toolchain package; keeping conservative widening.")
                }),
                IssueSeverity::Info,
                IssueScope::Workspace,
            )
        });
        return report;
    }

    let mut seeded = graph.modules_importing_external_packages(&diff.impacted_packages);
    if let Some(ref dirs) = diff.scoped_importer_dirs {
        seeded.retain(|path| dirs.iter().any(|dir| crate::scope::path_is_inside(path, dir)));
    }
    report.seeded_modules = seeded;
    report.handled_paths.insert(lockfile_path.to_owned());
    if pkg_changed {
        report.handled_paths.insert(MANIFEST_PATH.to_owned());
    }
    if pnpm_lock_changed {
        collect_handled_workspace_manifests(workspace_root, base_ref, scope, &mut report);
    }
    report.widened_importer_dirs = diff.widened_importer_dirs;
    report.impacted_packages = diff.impacted_packages;
    let detail = if report.seeded_modules.is_empty() && diff.newly_added_only {
        format!(
            "{lockfile_path} added {} unused package(s) with no toolchain impact; 0 workspace modules import them.",
            report.impacted_packages.len()
        )
    } else {
        format!(
            "{lockfile_path} impacted {} package(s), seeding {} workspace module(s).",
            report.impacted_packages.len(),
            report.seeded_modules.len()
        )
    };
    report.issues.push(PlanIssue {
        path: Some(lockfile_path.to_owned()),
        ..PlanIssue::new(
            "lockfile-narrowed",
            detail,
            IssueSeverity::Info,
            IssueScope::Workspace,
        )
    });
    report
}

fn collect_handled_workspace_manifests(
    workspace_root: &Path,
    base_ref: &str,
    scope: &ResolvedScope,
    report: &mut LockfileImpactReport,
) {
    for path in &scope.changed_paths {
        if path.ends_with("/package.json")
            && let Some(base_pkg) = read_git_file(workspace_root, base_ref, path)
            && let Some(head_pkg) = read_target_file(workspace_root, scope, path)
            && only_dependency_blocks_changed(&base_pkg, &head_pkg)
        {
            report.handled_paths.insert(path.clone());
        }
    }
}

fn validate_manifest_change(
    workspace_root: &Path,
    base_ref: &str,
    scope: &ResolvedScope,
    report: &mut LockfileImpactReport,
) -> bool {
    let Some(base_pkg) = read_git_file(workspace_root, base_ref, MANIFEST_PATH) else {
        return false;
    };
    let Some(head_pkg) = read_target_file(workspace_root, scope, MANIFEST_PATH) else {
        return false;
    };
    if !only_dependency_blocks_changed(&base_pkg, &head_pkg) {
        report.issues.push(PlanIssue {
            path: Some(MANIFEST_PATH.to_owned()),
            ..PlanIssue::new(
                "lockfile-manifest-global-change",
                "package.json changed outside dependency blocks; keeping conservative widening.",
                IssueSeverity::Info,
                IssueScope::Workspace,
            )
        });
        return false;
    }
    true
}

struct LockfileDiffOutcome {
    impacted_packages: BTreeSet<String>,
    scoped_importer_dirs: Option<BTreeSet<String>>,
    widened_importer_dirs: BTreeSet<String>,
    newly_added_only: bool,
    must_widen: bool,
    widen_reason: Option<String>,
}

fn diff_lockfiles_v3(base_raw: &str, head_raw: &str) -> Option<LockfileDiffOutcome> {
    let base_map = parse_lockfile_v3_packages(base_raw)?;
    let head_map = parse_lockfile_v3_packages(head_raw)?;
    diff_lockfile_maps(&base_map, &head_map)
}

fn diff_pnpm_lockfiles_v9(base_raw: &str, head_raw: &str) -> Option<LockfileDiffOutcome> {
    let out = diff_pnpm_lockfile_v9(base_raw, head_raw)?;
    Some(LockfileDiffOutcome {
        impacted_packages: out.impacted_packages,
        scoped_importer_dirs: out.scoped_importer_dirs,
        widened_importer_dirs: out.widened_importer_dirs,
        newly_added_only: out.newly_added_only,
        must_widen: out.must_widen,
        widen_reason: out.widen_reason,
    })
}

fn diff_lockfile_maps(
    base_map: &BTreeMap<String, PackageSnapshot>,
    head_map: &BTreeMap<String, PackageSnapshot>,
) -> Option<LockfileDiffOutcome> {

    let mut direct_changed = BTreeSet::new();
    let mut newly_added = BTreeSet::new();
    let mut existing_changed_or_removed = BTreeSet::new();
    for (key, head_entry) in head_map {
        match base_map.get(key) {
            None => {
                direct_changed.insert(head_entry.name.clone());
                newly_added.insert(head_entry.name.clone());
            }
            Some(base_entry) if base_entry != head_entry => {
                direct_changed.insert(head_entry.name.clone());
                existing_changed_or_removed.insert(head_entry.name.clone());
            }
            _ => {}
        }
    }
    for (key, base_entry) in base_map {
        if !head_map.contains_key(key) {
            direct_changed.insert(base_entry.name.clone());
            existing_changed_or_removed.insert(base_entry.name.clone());
        }
    }

    let mut reverse_deps: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut all_packages: BTreeSet<String> = BTreeSet::new();
    let mut existing_with_bin_or_install: BTreeSet<String> = BTreeSet::new();
    let base_names: BTreeSet<&str> = base_map.values().map(|e| e.name.as_str()).collect();
    for entry in base_map.values().chain(head_map.values()) {
        all_packages.insert(entry.name.clone());
        if (entry.has_bin || entry.has_install_script) && base_names.contains(entry.name.as_str()) {
            existing_with_bin_or_install.insert(entry.name.clone());
        }
        for dep in &entry.deps {
            reverse_deps
                .entry(dep.clone())
                .or_default()
                .insert(entry.name.clone());
        }
    }

    let mut closure = BTreeSet::new();
    let mut queue = VecDeque::new();
    for pkg in &direct_changed {
        if !all_packages.contains(pkg) {
            return Some(LockfileDiffOutcome {
                impacted_packages: BTreeSet::new(),
                scoped_importer_dirs: None,
                widened_importer_dirs: BTreeSet::new(),
                newly_added_only: false,
                must_widen: true,
                widen_reason: Some(format!("Changed package {pkg} is missing from lockfile.")),
            });
        }
        if closure.insert(pkg.clone()) {
            queue.push_back(pkg.clone());
        }
    }
    while let Some(current) = queue.pop_front() {
        if let Some(dependents) = reverse_deps.get(&current) {
            for dependent in dependents {
                if closure.insert(dependent.clone()) {
                    queue.push_back(dependent.clone());
                }
            }
        }
    }

    let trigger_reason = closure.iter().find_map(|pkg| {
        if is_toolchain_package(pkg) {
            Some(format!("Lockfile impacted toolchain package {pkg}; widening affected tasks."))
        } else if existing_changed_or_removed.contains(pkg)
            && existing_with_bin_or_install.contains(pkg)
        {
            Some(format!("Lockfile changed existing package {pkg} with bin/install script; widening affected tasks."))
        } else {
            None
        }
    });
    if let Some(reason) = trigger_reason {
        return Some(LockfileDiffOutcome {
            impacted_packages: closure,
            scoped_importer_dirs: None,
            widened_importer_dirs: BTreeSet::new(),
            newly_added_only: false,
            must_widen: true,
            widen_reason: Some(reason),
        });
    }

    Some(LockfileDiffOutcome {
        impacted_packages: closure,
        scoped_importer_dirs: None,
        widened_importer_dirs: BTreeSet::new(),
        newly_added_only: existing_changed_or_removed.is_empty() && !newly_added.is_empty(),
        must_widen: false,
        widen_reason: None,
    })
}

fn read_git_file(workspace_root: &Path, rev: &str, relative_path: &str) -> Option<String> {
    let spec = format!("{rev}:{relative_path}");
    let output = Command::new("git")
        .args(["show", &spec])
        .current_dir(workspace_root)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
}

fn read_target_file(
    workspace_root: &Path,
    scope: &ResolvedScope,
    relative_path: &str,
) -> Option<String> {
    if scope.kind == "commit-to-commit" {
        read_git_file(workspace_root, scope.head.as_deref()?, relative_path)
    } else {
        fs::read_to_string(workspace_root.join(relative_path)).ok()
    }
}
