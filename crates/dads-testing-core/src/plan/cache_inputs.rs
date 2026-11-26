//! Planner-owned task receipt cache input closure.
//!
//! Computes the exact set of workspace roots, impact path declarations, and extra files that can
//! affect a runnable task while the planner still holds the language dependency graph, failing
//! closed (`cacheable = false`) whenever closure soundness cannot be guaranteed.

use super::PlanEvidence;
use super::cache_inputs_helpers::{
    collect_seed_modules, expand_project_dependency_roots, is_closure_breaking_uncertainty,
    is_ignored_path, snapshot_pattern_globs, uncacheable_inputs,
};
use super::widening_fs::{FS_DIR_PREFIX, is_ambient_dts_path};
use crate::graph::{DependencyGraph, GraphUncertainty, ImportKind, ModuleNode};
use crate::manifest::{DeclaredTask, ImpactMode, Project, TaskKind, TestingManifest};
use crate::protocol::{ResolvedScope, TaskCacheInputs};
use crate::scope::{deepest_project_for_path, path_is_inside};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

struct ForwardClosure {
    visited_nodes: BTreeSet<usize>,
    dynamic_scope_paths: BTreeSet<String>,
    file_read_targets: BTreeSet<String>,
    file_read_dirs: BTreeSet<String>,
    using_full_project: bool,
}

pub(super) struct CacheInputIndex<'a> {
    manifest: &'a TestingManifest,
    projects_by_id: BTreeMap<&'a str, &'a Project>,
    unified_project_deps: &'a BTreeMap<&'a str, BTreeSet<&'a str>>,
    has_graph: bool,
    nodes: &'a [ModuleNode],
    node_by_path: HashMap<&'a str, usize>,
    nodes_by_project: BTreeMap<&'a str, Vec<usize>>,
    owner_by_node: Vec<Option<&'a str>>,
    blocking_uncertainties_by_path: BTreeSet<String>,
    unindexed_blocking_projects: BTreeSet<&'a str>,
    ambient_dts_files: Vec<String>,
}

impl<'a> CacheInputIndex<'a> {
    pub(super) fn new(
        manifest: &'a TestingManifest,
        graph: Option<&DependencyGraph>,
        nodes: &'a [ModuleNode],
        unified_project_deps: &'a BTreeMap<&'a str, BTreeSet<&'a str>>,
        enforce_declared_reads: bool,
    ) -> Self {
        let projects_by_id: BTreeMap<&'a str, &'a Project> = manifest
            .projects
            .iter()
            .map(|project| (project.id.as_str(), project))
            .collect();
        let mut node_by_path = HashMap::with_capacity(nodes.len());
        let mut nodes_by_project: BTreeMap<&'a str, Vec<usize>> = BTreeMap::new();
        let mut owner_by_node = Vec::with_capacity(nodes.len());
        let mut ambient_dts_files = Vec::new();
        for (idx, node) in nodes.iter().enumerate() {
            node_by_path.insert(node.path.as_str(), idx);
            if is_ambient_dts_path(&node.path) {
                ambient_dts_files.push(node.path.clone());
            }
            let ignored = is_ignored_path(&node.path, &manifest.workspace.ignore_paths);
            let owner = if ignored {
                None
            } else {
                deepest_project_for_path(&manifest.projects, &node.path).map(|p| p.id.as_str())
            };
            owner_by_node.push(owner);
            if let Some(proj_id) = owner {
                nodes_by_project.entry(proj_id).or_default().push(idx);
            }
        }
        let mut blocking_uncertainties_by_path = BTreeSet::new();
        let mut unindexed_blocking_projects = BTreeSet::new();
        if let Some(graph) = graph {
            for uncertainty in graph.uncertainties() {
                if !is_closure_breaking_uncertainty(
                    &uncertainty,
                    &manifest.workspace.dynamic_import_scopes,
                    enforce_declared_reads,
                ) {
                    continue;
                }
                if !node_by_path.contains_key(uncertainty.path.as_str())
                    && let Some(owner) =
                        deepest_project_for_path(&manifest.projects, &uncertainty.path)
                {
                    unindexed_blocking_projects.insert(owner.id.as_str());
                }
                blocking_uncertainties_by_path.insert(uncertainty.path);
            }
        }
        Self {
            manifest,
            projects_by_id,
            unified_project_deps,
            has_graph: graph.is_some(),
            nodes,
            node_by_path,
            nodes_by_project,
            owner_by_node,
            blocking_uncertainties_by_path,
            unindexed_blocking_projects,
            ambient_dts_files,
        }
    }

    pub(super) fn for_task(
        &self,
        task: &DeclaredTask,
        scope: &ResolvedScope,
        evidence: &PlanEvidence<'_>,
        selected_files: &[String],
    ) -> TaskCacheInputs {
        if task.impact.mode == ImpactMode::Always
            || (scope.full_fallback && scope.kind != "all")
            || evidence.full_fallback
            || ((task.impact.mode == ImpactMode::Reachability || scope.kind == "all")
                && !self.has_graph)
            || !self.projects_by_id.contains_key(task.project.as_str())
        {
            return uncacheable_inputs();
        }
        let setup_files: &[String] = task
            .execution
            .file_narrowing
            .as_ref()
            .map_or(&[], |narrowing| narrowing.setup_files.as_slice());
        if selected_files
            .iter()
            .chain(setup_files.iter())
            .any(|path| self.blocking_uncertainties_by_path.contains(path))
        {
            return uncacheable_inputs();
        }
        let Some(closure) = self.walk_forward_closure(&task.project, selected_files, setup_files)
        else {
            return uncacheable_inputs();
        };
        let mut seed_projects = BTreeSet::from([task.project.as_str()]);
        for &node_idx in &closure.visited_nodes {
            if let Some(owner) = self.owner_by_node[node_idx] {
                seed_projects.insert(owner);
            }
        }
        let Some(project_roots) = expand_project_dependency_roots(
            &self.projects_by_id,
            self.unified_project_deps,
            &seed_projects,
            task.project.as_str(),
            closure.using_full_project || !self.has_graph,
        ) else {
            return uncacheable_inputs();
        };
        let mut impact_paths = self.collect_impact_paths(task, closure.dynamic_scope_paths);
        for dir in closure.file_read_dirs {
            if !project_roots.iter().any(|root| path_is_inside(&dir, root)) {
                impact_paths.insert(dir);
            }
        }
        let mut extra_files: BTreeSet<String> = setup_files.iter().cloned().collect();
        for &node_idx in &closure.visited_nodes {
            let path = &self.nodes[node_idx].path;
            if path.starts_with(FS_DIR_PREFIX) {
                continue;
            }
            if !project_roots.iter().any(|root| path_is_inside(path, root)) {
                extra_files.insert(path.clone());
            }
        }
        if task.kind == TaskKind::Typecheck {
            for dts in &self.ambient_dts_files {
                if !project_roots.iter().any(|root| path_is_inside(dts, root)) {
                    extra_files.insert(dts.clone());
                }
            }
        }
        for path in closure.file_read_targets {
            if !project_roots.iter().any(|root| path_is_inside(&path, root)) {
                extra_files.insert(path);
            }
        }
        TaskCacheInputs {
            cacheable: true,
            project_roots: project_roots.into_iter().collect(),
            impact_paths: impact_paths.into_iter().collect(),
            extra_files: extra_files.into_iter().collect(),
        }
    }

    fn walk_forward_closure(
        &self,
        project_id: &str,
        selected_files: &[String],
        setup_files: &[String],
    ) -> Option<ForwardClosure> {
        if !self.has_graph {
            return Some(ForwardClosure {
                visited_nodes: BTreeSet::new(),
                dynamic_scope_paths: BTreeSet::new(),
                file_read_targets: BTreeSet::new(),
                file_read_dirs: BTreeSet::new(),
                using_full_project: true,
            });
        }
        let (seeds, using_full_project) = collect_seed_modules(
            &self.node_by_path,
            &self.nodes_by_project,
            project_id,
            selected_files,
            setup_files,
        );
        if using_full_project && self.unindexed_blocking_projects.contains(project_id) {
            return None;
        }
        let mut visited_nodes = BTreeSet::new();
        let mut queue = VecDeque::new();
        for idx in seeds {
            if visited_nodes.insert(idx) {
                queue.push_back(idx);
            }
        }
        let mut dynamic_scope_paths = BTreeSet::new();
        let mut file_read_targets = BTreeSet::new();
        let mut file_read_dirs = BTreeSet::new();
        while let Some(node_idx) = queue.pop_front() {
            let node = &self.nodes[node_idx];
            if let Some(dir) = node.path.strip_prefix(FS_DIR_PREFIX) {
                if !dir.is_empty() {
                    dynamic_scope_paths.insert(dir.to_owned());
                }
                continue;
            }
            if self.blocking_uncertainties_by_path.contains(&node.path) {
                return None;
            }
            if let Some(prefixes) = self
                .manifest
                .workspace
                .dynamic_import_scopes
                .get(&node.path)
            {
                for prefix in prefixes {
                    dynamic_scope_paths.insert(prefix.clone());
                }
                for (candidate_idx, candidate) in self.nodes.iter().enumerate() {
                    if !visited_nodes.contains(&candidate_idx)
                        && prefixes
                            .iter()
                            .any(|prefix| path_matches_impact(&candidate.path, prefix))
                        && visited_nodes.insert(candidate_idx)
                    {
                        queue.push_back(candidate_idx);
                    }
                }
            }
            for imp in &node.imports {
                let Some(target) = imp.resolved_path.as_deref() else {
                    continue;
                };
                if is_ignored_path(target, &self.manifest.workspace.ignore_paths) {
                    continue;
                }
                if imp.kind == ImportKind::FileRead {
                    if let Some(dir) = target.strip_suffix('/') {
                        file_read_dirs.insert(dir.to_owned());
                    } else {
                        file_read_targets.insert(target.to_owned());
                    }
                    continue;
                }
                if self.blocking_uncertainties_by_path.contains(target) {
                    return None;
                }
                if let Some(&target_idx) = self.node_by_path.get(target)
                    && visited_nodes.insert(target_idx)
                {
                    queue.push_back(target_idx);
                }
            }
        }
        Some(ForwardClosure {
            visited_nodes,
            dynamic_scope_paths,
            file_read_targets,
            file_read_dirs,
            using_full_project,
        })
    }

    fn collect_impact_paths(
        &self,
        task: &DeclaredTask,
        mut dynamic_scope_paths: BTreeSet<String>,
    ) -> BTreeSet<String> {
        let mut impact_paths: BTreeSet<String> = task.impact.paths.iter().cloned().collect();
        impact_paths.append(&mut dynamic_scope_paths);
        if task.sql_impact.is_some()
            && let Some(sql) = &self.manifest.workspace.sql
        {
            for root in &sql.migration_roots {
                let trimmed = if root == "." {
                    "."
                } else {
                    root.trim_end_matches('/')
                };
                if !trimmed.is_empty() {
                    impact_paths.insert(trimmed.to_owned());
                }
            }
            for pattern in &sql.snapshot_patterns {
                for glob in snapshot_pattern_globs(&pattern.prefix, &pattern.suffix) {
                    impact_paths.insert(glob);
                }
            }
        }
        impact_paths
    }
}
