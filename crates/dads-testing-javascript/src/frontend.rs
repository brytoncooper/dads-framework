//! The entry points the store and CLI call: a whole-workspace analysis, a request-scoped graph,
//! and the incremental replacement path that decides when a patch is still safe.

use crate::changed_module_evidence::changed_module_evidence;
use crate::facts::{JsUncertainty, JsWorkspaceFacts};
use crate::graph_export::copy_to_core_graph;
use crate::module_analysis::analyze_file;
use crate::removed_paths::removed_javascript_path_exists;
use crate::workspace::{git_output, is_javascript_path, uncertainty, workspace_relative_path};
use dads_testing_core::NativeRequest;
use dads_testing_core::graph::DependencyGraph;
use dads_testing_store::GraphFrontend;
use oxc_resolver::{ResolveOptions, Resolver, TsconfigDiscovery};
use std::fs;
use std::path::{Path, PathBuf};

pub fn analyze_workspace(workspace_root: &Path) -> JsWorkspaceFacts {
    analyze_workspace_roots(workspace_root, None)
}

pub(crate) fn analyze_workspace_roots(
    workspace_root: &Path,
    project_roots: Option<&[String]>,
) -> JsWorkspaceFacts {
    let mut files = Vec::new();
    let mut uncertainties = Vec::new();
    let scan_roots = resolve_scan_roots(workspace_root, project_roots);
    let scoped = scan_roots.len() > 1
        || scan_roots
            .first()
            .is_some_and(|root| root != workspace_root);
    for scan_root in scan_roots {
        collect_javascript_files(workspace_root, &scan_root, &mut files, &mut uncertainties);
    }
    if scoped {
        collect_root_javascript_files(workspace_root, &mut files);
    }
    files.sort();
    files.dedup();

    let resolver = javascript_resolver();
    let mut modules = Vec::new();
    for absolute_path in files {
        let path = workspace_relative_path(workspace_root, &absolute_path)
            .unwrap_or_else(|| absolute_path.to_string_lossy().replace('\\', "/"));
        match analyze_file(workspace_root, &absolute_path, &path, &resolver) {
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

/// Uses manifest project roots when none declares the workspace root `"."`, avoiding spurious
/// uncertainties from unrelated repo scripts or fixtures outside declared projects.
fn resolve_scan_roots(workspace_root: &Path, project_roots: Option<&[String]>) -> Vec<PathBuf> {
    let Some(roots) = project_roots else {
        return vec![workspace_root.to_path_buf()];
    };
    if roots.is_empty()
        || roots.iter().any(|root| {
            let trimmed = root.trim().trim_end_matches('/');
            trimmed.is_empty() || trimmed == "."
        })
    {
        return vec![workspace_root.to_path_buf()];
    }
    let mut resolved = roots
        .iter()
        .map(|root| workspace_root.join(root))
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    resolved.sort();
    resolved.dedup();
    if resolved.is_empty() {
        vec![workspace_root.to_path_buf()]
    } else {
        resolved
    }
}

fn collect_root_javascript_files(workspace_root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(workspace_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_file()) && is_javascript_path(&path) {
            files.push(path);
        }
    }
}

fn javascript_resolver() -> Resolver {
    Resolver::new(ResolveOptions {
        tsconfig: Some(TsconfigDiscovery::Auto),
        condition_names: vec!["node".to_owned(), "import".to_owned(), "default".to_owned()],
        extensions: vec![
            ".js".to_owned(),
            ".jsx".to_owned(),
            ".mjs".to_owned(),
            ".cjs".to_owned(),
            ".ts".to_owned(),
            ".tsx".to_owned(),
            ".mts".to_owned(),
            ".cts".to_owned(),
            ".json".to_owned(),
            ".node".to_owned(),
        ],
        ..ResolveOptions::default()
    })
}

/// Produces core-owned graph evidence for the current working tree.
///
/// Commit-to-commit planning intentionally returns no evidence: current files cannot prove which
/// declarations changed in an arbitrary requested head revision.
pub fn analyze_request(request: &NativeRequest) -> Option<DependencyGraph> {
    if request.all {
        return None;
    }
    let workspace_root = Path::new(&request.workspace_root);
    if !workspace_root.is_absolute() || !workspace_root.is_dir() {
        return None;
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
    let facts = analyze_workspace_roots(workspace_root, project_roots.as_deref());
    let changes = changed_module_evidence(workspace_root, request.base.as_deref(), &facts.modules)?;
    Some(copy_to_core_graph(facts).with_changed_module_evidence(changes))
}

/// The JS/TS frontend keeps no daemon state. The store owns persisted facts and asks this
/// frontend for either an initial graph or an incremental replacement.
pub struct JavaScriptFrontend;

impl GraphFrontend for JavaScriptFrontend {
    fn frontend_version(&self) -> u32 {
        9
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
    if previous.has_uncertainty() {
        return Err(
            "A graph with uncertainty requires a full rebuild before its files change.".to_owned(),
        );
    }
    if request.all
        || request.head.is_some()
        || changed_paths
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
    let resolver = javascript_resolver();
    let mut facts = JsWorkspaceFacts {
        modules: Vec::new(),
        uncertainties: Vec::new(),
    };
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
        match analyze_file(workspace_root, &absolute_path, path, &resolver) {
            Ok((module, mut uncertainties)) => {
                facts.modules.push(module);
                facts.uncertainties.append(&mut uncertainties);
            }
            Err(uncertainty) => facts.uncertainties.push(uncertainty),
        }
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
    let patched = copy_to_core_graph(facts);
    let modules = patched.materialize_modules();
    // Fresh adapter uncertainties are deliberately not persisted as a usable snapshot.
    if patched.has_uncertainty() {
        return Err("Changed files have uncertain graph facts.".to_owned());
    }
    Ok(previous.patch_modules(modules, merged_changes, Vec::new()))
}

fn collect_javascript_files(
    workspace_root: &Path,
    directory: &Path,
    files: &mut Vec<PathBuf>,
    uncertainties: &mut Vec<JsUncertainty>,
) {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            uncertainties.push(uncertainty(
                workspace_root,
                directory,
                "javascript-directory-read-failed",
                format!("Could not inspect JavaScript sources: {error}"),
            ));
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                uncertainties.push(JsUncertainty {
                    path: String::new(),
                    code: "javascript-directory-entry-failed".to_owned(),
                    message: format!("Could not inspect a workspace entry: {error}"),
                    span: None,
                    position: None,
                });
                continue;
            }
        };
        let path = entry.path();
        let file_name = entry.file_name();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            if matches!(
                file_name.to_str(),
                Some(
                    ".git"
                        | "node_modules"
                        | "target"
                        | "dist"
                        | "coverage"
                        | ".next"
                        | ".lake"
                        | "_apalache-out"
                )
            ) {
                continue;
            }
            collect_javascript_files(workspace_root, &path, files, uncertainties);
        } else if is_javascript_path(&path) {
            files.push(path);
        }
    }
}
