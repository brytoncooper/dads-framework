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
