//! Path filtering and uncovered-directory `FileRead` helpers for graph widening.
use super::PlanEvidence;
use super::widening::{
    record_reachable_paths, record_reachable_uncertainties, record_uncovered_paths,
};
use super::widening_fs::{widen_ambient_dts_typechecks, widen_unresolved_fs_readers};
use crate::graph::DependencyGraph;
use crate::manifest::TestingManifest;
use crate::protocol::ResolvedScope;
use crate::scope::path_matches_impact;

pub(super) fn collect_graph_changed_paths(
    manifest: &TestingManifest,
    scope: &ResolvedScope,
    graph: Option<&DependencyGraph>,
    evidence: &PlanEvidence<'_>,
) -> Vec<String> {
    let mut changed_paths: Vec<String> = scope
        .changed_paths
        .iter()
        .filter(|path| {
            !manifest
                .workspace
                .ignore_paths
                .iter()
                .any(|pattern| path_matches_impact(path, pattern))
        })
        .filter(|path| !is_declared_non_code(path, &manifest.workspace.non_code_suffixes))
        .filter(|path| !evidence.lockfile_handled_paths.contains(*path))
        .filter(|path| !evidence.tsconfig_handled_paths.contains(*path))
        .filter(|path| {
            !evidence.sql_handled_paths.contains(*path)
                || graph.is_some_and(|g| g.contains_path(path))
        })
        .cloned()
        .collect();
    for seeded in evidence
        .lockfile_seeded_modules
        .iter()
        .chain(&evidence.tsconfig_seeded_modules)
    {
        if !changed_paths.contains(seeded) {
            changed_paths.push(seeded.clone());
        }
    }
    changed_paths
}

pub(super) fn widen_uncovered_paths<'a>(
    manifest: &'a TestingManifest,
    changed_paths: &[String],
    uncovered_paths: &[String],
    graph: &DependencyGraph,
    evidence: &mut PlanEvidence<'a>,
    has_non_test_reachability: bool,
    enforce_declared_reads: bool,
) {
    record_uncovered_paths(manifest, uncovered_paths, evidence);
    if has_non_test_reachability {
        widen_ambient_dts_typechecks(manifest, uncovered_paths, None, evidence);
    }
    if !enforce_declared_reads {
        widen_unresolved_fs_readers(manifest, graph, evidence, has_non_test_reachability);
    }
    record_uncovered_file_read_dirs(
        manifest,
        changed_paths,
        uncovered_paths,
        graph,
        evidence,
        has_non_test_reachability,
        enforce_declared_reads,
    );
    let workspace_uncertainties = graph.whole_workspace_uncertainties();
    record_reachable_uncertainties(
        manifest,
        changed_paths,
        graph,
        workspace_uncertainties.clone(),
        evidence,
        true,
        enforce_declared_reads,
    );
    if has_non_test_reachability {
        record_reachable_uncertainties(
            manifest,
            changed_paths,
            graph,
            workspace_uncertainties,
            evidence,
            false,
            enforce_declared_reads,
        );
    }
}

fn record_uncovered_file_read_dirs<'a>(
    manifest: &'a TestingManifest,
    changed_paths: &[String],
    uncovered_paths: &[String],
    graph: &DependencyGraph,
    evidence: &mut PlanEvidence<'a>,
    has_non_test_reachability: bool,
    enforce_declared_reads: bool,
) {
    let dir_matched: Vec<String> = uncovered_paths
        .iter()
        .filter(|path| graph.has_file_read_dir_for(path))
        .cloned()
        .collect();
    if dir_matched.is_empty() {
        return;
    }
    let rt_dir = graph.file_read_reachability(dir_matched.clone(), true);
    record_reachable_paths(manifest, &rt_dir.paths, evidence, true);
    record_reachable_uncertainties(
        manifest,
        changed_paths,
        graph,
        rt_dir.uncertainties,
        evidence,
        true,
        enforce_declared_reads,
    );
    evidence.reached_edges.extend(rt_dir.edges);
    if has_non_test_reachability {
        let full_dir = graph.file_read_reachability(dir_matched, false);
        record_reachable_paths(manifest, &full_dir.paths, evidence, false);
        record_reachable_uncertainties(
            manifest,
            changed_paths,
            graph,
            full_dir.uncertainties,
            evidence,
            false,
            enforce_declared_reads,
        );
    }
}

pub(super) fn is_javascript_source_path(path: &str) -> bool {
    const JS_EXTS: &[&str] = &["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| JS_EXTS.contains(&ext))
}

fn is_declared_non_code(path: &str, suffixes: &[String]) -> bool {
    suffixes.iter().any(|suffix| path.ends_with(suffix))
}

/// When an upstream workspace project changes semantically (e.g. a compiled `dist/` package whose
/// `exports` cannot be traced directly into `src/`), any downstream dependent declared via
/// `fallbackDependencies` that carries an unresolved module import could depend on the changed
/// upstream package. Widen those unresolved importers conservatively so compiled-`dist/` monorepos
/// never silently skip affected downstream consumers.
pub(super) fn widen_unresolved_workspace_dependents<'a>(
    manifest: &'a TestingManifest,
    graph: &DependencyGraph,
    evidence: &mut PlanEvidence<'a>,
    has_non_test_reachability: bool,
) {
    let mut impacted: std::collections::BTreeSet<&'a str> = std::collections::BTreeSet::new();
    impacted.extend(evidence.reachability_impacted_projects.iter().copied());
    impacted.extend(
        evidence
            .typecheck_reachability_impacted_projects
            .iter()
            .copied(),
    );
    impacted.extend(evidence.uncertainty_impacted_projects.iter().copied());
    impacted.extend(
        evidence
            .typecheck_uncertainty_impacted_projects
            .iter()
            .copied(),
    );
    if impacted.is_empty() {
        return;
    }

    let mut downstream = impacted.clone();
    let mut changed = true;
    while changed {
        changed = false;
        for project in &manifest.projects {
            if !downstream.contains(project.id.as_str())
                && project
                    .fallback_dependencies
                    .iter()
                    .any(|dep| downstream.contains(dep.as_str()))
            {
                downstream.insert(project.id.as_str());
                changed = true;
            }
        }
    }

    let seeds: Vec<String> = graph
        .uncertainties()
        .into_iter()
        .filter(|u| {
            matches!(
                u.code.as_str(),
                "unresolved-bare-module" | "unresolved-module-scheme"
            )
        })
        .filter(|u| {
            crate::scope::deepest_project_for_path(&manifest.projects, &u.path).is_some_and(
                |project| {
                    downstream.contains(project.id.as_str())
                        && !impacted.contains(project.id.as_str())
                },
            )
        })
        .map(|u| u.path)
        .collect();
    if seeds.is_empty() {
        return;
    }
    super::widening_fs::widen_reached_unresolved_projects(
        manifest,
        graph,
        evidence,
        has_non_test_reachability,
        seeds,
        super::widening_fs::UnresolvedWidenSpec {
            code: "unresolved-workspace-dependency-import",
            fallback_on_unowned: false,
            detail: "depends on an unresolved module import in a downstream project of a changed workspace dependency; widened conservatively.",
        },
    );
}

/// When any changed path has been deleted from disk, its reverse edges vanish from the current
/// working-tree graph and every consumer that still imports it records an unresolved module
/// uncertainty. Widen unresolved importers in the deleted project and its transitive dependents.
pub(super) fn widen_unresolved_module_importers_on_delete<'a>(
    manifest: &'a TestingManifest,
    workspace_root: &std::path::Path,
    changed_paths: &[String],
    graph: &DependencyGraph,
    evidence: &mut PlanEvidence<'a>,
    has_non_test_reachability: bool,
) {
    let deleted: Vec<&String> = changed_paths
        .iter()
        .filter(|path| !workspace_root.join(path).is_file())
        .collect();
    if deleted.is_empty() {
        return;
    }
    let mut deleted_projects: std::collections::BTreeSet<&'a str> =
        std::collections::BTreeSet::new();
    let mut has_unowned_delete = false;
    for path in &deleted {
        match crate::scope::deepest_project_for_path(&manifest.projects, path) {
            Some(proj) => {
                deleted_projects.insert(proj.id.as_str());
            }
            None => has_unowned_delete = true,
        }
    }
    let mut downstream = deleted_projects.clone();
    let mut changed = true;
    while changed {
        changed = false;
        for proj in &manifest.projects {
            if !downstream.contains(proj.id.as_str())
                && proj
                    .fallback_dependencies
                    .iter()
                    .any(|dep| downstream.contains(dep.as_str()))
            {
                downstream.insert(proj.id.as_str());
                changed = true;
            }
        }
    }
    let deleted_stems: Vec<&str> = deleted
        .iter()
        .filter_map(|p| {
            let file = p.rsplit('/').next()?;
            let stem = file.split('.').next().filter(|s| !s.is_empty())?;
            if stem == "index" {
                p.rsplit('/').nth(1)
            } else {
                Some(stem)
            }
        })
        .collect();
    let seeds: Vec<String> = graph
        .uncertainties()
        .into_iter()
        .filter(|u| {
            matches!(
                u.code.as_str(),
                "unresolved-local-module" | "unresolved-bare-module" | "unresolved-module-scheme"
            )
        })
        .filter(|u| {
            if has_unowned_delete {
                return true;
            }
            if u.code == "unresolved-local-module" && u.message.contains("../") {
                return true;
            }
            if deleted_stems.iter().any(|stem| u.message.contains(stem)) {
                return true;
            }
            let Some(proj) = crate::scope::deepest_project_for_path(&manifest.projects, &u.path)
            else {
                return true;
            };
            if u.code == "unresolved-local-module" {
                deleted_projects.contains(proj.id.as_str())
            } else {
                downstream.contains(proj.id.as_str())
            }
        })
        .map(|u| u.path)
        .collect();
    if seeds.is_empty() {
        return;
    }
    super::widening_fs::widen_reached_unresolved_projects(
        manifest,
        graph,
        evidence,
        has_non_test_reachability,
        seeds,
        super::widening_fs::UnresolvedWidenSpec {
            code: "unresolved-import-after-delete",
            fallback_on_unowned: true,
            detail: "depends on an unresolved module import while changed workspace files were deleted; widened conservatively.",
        },
    );
}
