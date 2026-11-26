//! The entry points the store and CLI call: a whole-workspace analysis, a request-scoped graph,
//! and the incremental replacement path that decides when a patch is still safe.

use crate::asset_evidence::{asset_changed_evidence, referenced_asset_paths};
use crate::changed_module_evidence::changed_module_evidence;
use crate::facts::{JsImportKind, JsModuleFacts, JsUncertainty, JsWorkspaceFacts};
use crate::file_discovery::{WorkspaceFileIndex, discover_javascript_files};
use crate::graph_export::{copy_to_core_graph, copy_to_core_patch_parts};
use crate::module_analysis::analyze_file;
use crate::removed_paths::removed_javascript_path_exists;
use crate::workspace::{git_output, is_javascript_path, workspace_relative_path};
use dads_testing_core::NativeRequest;
use dads_testing_core::graph::DependencyGraph;
use dads_testing_store::GraphFrontend;
use oxc_resolver::{ResolveOptions, Resolver, TsconfigDiscovery};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

type FileAnalysisResult = Result<(JsModuleFacts, Vec<JsUncertainty>), JsUncertainty>;

pub fn analyze_workspace(workspace_root: &Path) -> JsWorkspaceFacts {
    analyze_workspace_roots(workspace_root, None, &[])
}

/// Analyzes the workspace's JavaScript/TypeScript modules in parallel and returns a core
/// `DependencyGraph` without requiring Git metadata or changed-module diff attribution.
pub fn analyze_workspace_graph(
    workspace_root: &Path,
    project_roots: Option<&[String]>,
) -> DependencyGraph {
    copy_to_core_graph(analyze_workspace_roots(workspace_root, project_roots, &[]))
}

pub(crate) fn analyze_workspace_roots(
    workspace_root: &Path,
    project_roots: Option<&[String]>,
    ignore_paths: &[String],
) -> JsWorkspaceFacts {
    let mut uncertainties = Vec::new();
    let files = discover_javascript_files(
        workspace_root,
        project_roots,
        ignore_paths,
        &mut uncertainties,
    );

    let targets = files
        .into_iter()
        .map(|absolute_path| {
            let path = workspace_relative_path(workspace_root, &absolute_path)
                .unwrap_or_else(|| absolute_path.to_string_lossy().replace('\\', "/"));
            (absolute_path, path)
        })
        .collect::<Vec<_>>();
    let resolver = javascript_resolver();
    let workspace_index = WorkspaceFileIndex::build(workspace_root);
    let mut modules = Vec::with_capacity(targets.len());
    for result in analyze_workspace_paths(workspace_root, &targets, &resolver, &workspace_index) {
        match result {
            Ok((module, mut file_uncertainties)) => {
                modules.push(module);
                uncertainties.append(&mut file_uncertainties);
            }
            Err(uncertainty) => uncertainties.push(uncertainty),
        }
    }
    JsWorkspaceFacts {
        modules,
        uncertainties,
    }
}

pub(crate) fn analyze_workspace_paths(
    workspace_root: &Path,
    targets: &[(PathBuf, String)],
    resolver: &Resolver,
    workspace_index: &WorkspaceFileIndex,
) -> Vec<FileAnalysisResult> {
    let workers = std::thread::available_parallelism()
        .map(NonZeroUsize::get)
        .unwrap_or(1)
        .min(targets.len());
    analyze_paths_with_workers(workspace_root, targets, resolver, workspace_index, workers)
}

fn analyze_paths_with_workers(
    workspace_root: &Path,
    targets: &[(PathBuf, String)],
    resolver: &Resolver,
    workspace_index: &WorkspaceFileIndex,
    max_workers: usize,
) -> Vec<FileAnalysisResult> {
    let workers = max_workers.min(targets.len());
    if targets.len() <= 1 || workers <= 1 {
        return targets
            .iter()
            .map(|(absolute_path, path)| {
                analyze_file(
                    workspace_root,
                    absolute_path,
                    path,
                    resolver,
                    workspace_index,
                )
            })
            .collect();
    }

    let next_index = AtomicUsize::new(0);
    let (mut indexed_results, all_joined) = std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            handles.push(scope.spawn(|| {
                let mut local = Vec::new();
                loop {
                    let index = next_index.fetch_add(1, Ordering::Relaxed);
                    let Some((absolute_path, path)) = targets.get(index) else {
                        break;
                    };
                    let result = analyze_file(
                        workspace_root,
                        absolute_path,
                        path,
                        resolver,
                        workspace_index,
                    );
                    local.push((index, result));
                }
                local
            }));
        }
        let mut collected = Vec::with_capacity(targets.len());
        let mut all_joined = true;
        for handle in handles {
            match handle.join() {
                Ok(local) => collected.extend(local),
                Err(_) => all_joined = false,
            }
        }
        (collected, all_joined)
    });
    if !all_joined {
        return analyze_paths_with_workers(workspace_root, targets, resolver, workspace_index, 1);
    }
    indexed_results.sort_unstable_by_key(|(index, _)| *index);
    indexed_results
        .into_iter()
        .map(|(_, result)| result)
        .collect()
}

fn javascript_resolver() -> Resolver {
    let owned = |items: &[&str]| items.iter().map(|item| (*item).to_owned()).collect();
    Resolver::new(ResolveOptions {
        tsconfig: Some(TsconfigDiscovery::Auto),
        condition_names: owned(&["node", "import", "default", "types"]),
        extensions: owned(&[
            ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".d.ts", ".d.mts",
            ".d.cts", ".json", ".node",
        ]),
        ..ResolveOptions::default()
    })
}

/// Produces core-owned graph evidence for the current working tree.
///
/// Commit-to-commit planning intentionally returns no evidence: current files cannot prove which
/// declarations changed in an arbitrary requested head revision.
pub fn analyze_request(request: &NativeRequest) -> Option<DependencyGraph> {
    let workspace_root = Path::new(&request.workspace_root);
    if !workspace_root.is_absolute() || !workspace_root.is_dir() {
        return None;
    }
    if request.all {
        let project_roots = dads_testing_core::manifest_project_roots(request);
        let ignore_paths = dads_testing_core::manifest_ignore_paths(request);
        let facts =
            analyze_workspace_roots(workspace_root, project_roots.as_deref(), &ignore_paths);
        return Some(copy_to_core_graph(facts));
    }
    if let Some(head) = &request.head {
        let requested = git_output(workspace_root, &["rev-parse", "--verify", head])?;
        let current = git_output(workspace_root, &["rev-parse", "--verify", "HEAD"])?;
        if requested != current {
            return None;
        }
        let worktree_status = git_output(
            workspace_root,
            &["status", "--porcelain=v1", "--untracked-files=all", "-z"],
        )?;
        if !worktree_status.is_empty() {
            // A requested head only describes the current source tree when every tracked and
            // untracked path is clean. Otherwise a base-to-head diff would be attributed using
            // declarations from a different tree and could skip a broken consumer.
            return None;
        }
    }
    let project_roots = dads_testing_core::manifest_project_roots(request);
    let ignore_paths = dads_testing_core::manifest_ignore_paths(request);
    let facts = analyze_workspace_roots(workspace_root, project_roots.as_deref(), &ignore_paths);
    if request
        .base
        .as_deref()
        .is_some_and(dads_testing_core::is_empty_tree_sha)
    {
        return Some(copy_to_core_graph(facts));
    }
    let asset_paths = referenced_asset_paths(&facts.modules);
    let mut changes =
        changed_module_evidence(workspace_root, request.base.as_deref(), &facts.modules)?;
    changes.extend(asset_changed_evidence(
        workspace_root,
        request.base.as_deref(),
        &asset_paths,
    )?);
    Some(copy_to_core_graph(facts).with_changed_module_evidence(changes))
}

/// The JS/TS frontend keeps no daemon state. The store owns persisted facts and asks this
/// frontend for either an initial graph or an incremental replacement.
pub struct JavaScriptFrontend;

impl GraphFrontend for JavaScriptFrontend {
    fn frontend_version(&self) -> u32 {
        19
    }

    fn initial_index(&mut self, request: &NativeRequest) -> Result<DependencyGraph, String> {
        analyze_request(request).ok_or_else(|| {
            "JavaScript/TypeScript graph evidence is unavailable for this ref.".to_owned()
        })
    }

    fn incremental_update(
        &mut self,
        request: &NativeRequest,
        previous: DependencyGraph,
        changed_paths: &[String],
    ) -> Result<DependencyGraph, String> {
        incremental_request(request, previous, changed_paths)
    }
}

pub(crate) fn incremental_request(
    request: &NativeRequest,
    previous: DependencyGraph,
    changed_paths: &[String],
) -> Result<DependencyGraph, String> {
    if previous
        .uncertainties()
        .iter()
        .any(|uncertainty| !previous.contains_path(&uncertainty.path))
    {
        return Err(
            "A graph with uncertainty requires a full rebuild before its files change.".to_owned(),
        );
    }
    if request.all || request.head.is_some() {
        return Err("Changed paths require a full graph rebuild.".to_owned());
    }
    let ignore_paths = dads_testing_core::manifest_ignore_paths(request);
    let changed_paths: Vec<String> = changed_paths
        .iter()
        .filter(|path| {
            !ignore_paths
                .iter()
                .any(|pattern| dads_testing_core::path_matches_impact(path, pattern))
        })
        .cloned()
        .collect();
    if changed_paths.is_empty() {
        return Ok(previous);
    }
    if changed_paths
        .iter()
        .any(|path| !is_javascript_path(Path::new(path)))
    {
        return Err("Changed paths require a full graph rebuild.".to_owned());
    }
    let workspace_root = Path::new(&request.workspace_root);
    if removed_javascript_path_exists(workspace_root)
        .ok_or_else(|| "Cannot establish removed JavaScript paths.".to_owned())?
    {
        // A staged rename can supply only its destination to the snapshot store. Patching that
        // path would retain the old module and its resolution edges, so rebuild the current graph.
        return Err("A delete or rename invalidates retained resolution edges.".to_owned());
    }
    let facts = analyze_changed_paths(workspace_root, &previous, &changed_paths)?;
    if facts.modules.iter().any(|module| {
        module.imports.iter().any(|import| {
            matches!(import.kind, JsImportKind::Asset | JsImportKind::FileRead)
                && import
                    .resolved_path
                    .as_deref()
                    .is_some_and(|resolved| !previous.contains_path(resolved))
        })
    }) {
        return Err("A newly referenced asset requires a full graph rebuild.".to_owned());
    }
    let fresh_changes =
        changed_module_evidence(workspace_root, request.base.as_deref(), &facts.modules)
            .ok_or_else(|| "Cannot attribute changed module exports.".to_owned())?;
    let patched_set = changed_paths
        .iter()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let mut merged_changes = previous
        .changed_module_evidences()
        .into_iter()
        .filter(|entry| !patched_set.contains(entry.path.as_str()))
        .collect::<Vec<_>>();
    merged_changes.extend(fresh_changes);
    let (modules, patched_uncertainties) = copy_to_core_patch_parts(facts);
    let mut uncertainties_by_path = std::collections::BTreeMap::<String, Vec<_>>::new();
    for uncertainty in previous
        .uncertainties()
        .into_iter()
        .filter(|entry| !patched_set.contains(entry.path.as_str()))
        .chain(patched_uncertainties)
    {
        uncertainties_by_path
            .entry(uncertainty.path.clone())
            .or_default()
            .push(uncertainty);
    }
    let merged_uncertainties = uncertainties_by_path
        .into_values()
        .flatten()
        .collect::<Vec<_>>();
    Ok(previous.patch_modules(modules, merged_changes, merged_uncertainties))
}

fn analyze_changed_paths(
    workspace_root: &Path,
    previous: &DependencyGraph,
    changed_paths: &[String],
) -> Result<JsWorkspaceFacts, String> {
    let mut targets = Vec::with_capacity(changed_paths.len());
    for path in changed_paths {
        if !previous.contains_path(path) {
            // A newly created source file can shadow or redirect resolution for unchanged
            // importers (for example `foo/index.ts` or `foo.ts`), so rebuild the full graph.
            return Err("A newly added file invalidates retained resolution edges.".to_owned());
        }
        let absolute_path = workspace_root.join(path);
        if !absolute_path.is_file() {
            return Err("A delete or rename invalidates retained resolution edges.".to_owned());
        }
        targets.push((absolute_path, path.clone()));
    }
    let resolver = javascript_resolver();
    let workspace_index = WorkspaceFileIndex::build(workspace_root);
    let mut facts = JsWorkspaceFacts {
        modules: Vec::with_capacity(targets.len()),
        uncertainties: Vec::new(),
    };
    for result in analyze_workspace_paths(workspace_root, &targets, &resolver, &workspace_index) {
        match result {
            Ok((module, mut uncertainties)) => {
                facts.modules.push(module);
                facts.uncertainties.append(&mut uncertainties);
            }
            Err(_) => {
                // An unreadable changed file has no module node to overwrite the previous one.
                return Err("Changed file could not be read for incremental patch.".to_owned());
            }
        }
    }
    Ok(facts)
}
