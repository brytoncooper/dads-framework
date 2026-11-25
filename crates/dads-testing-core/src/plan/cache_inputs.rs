//! Planner-owned task receipt cache input closure.
//!
//! Computes the exact set of workspace roots, impact path declarations, and extra files that can
//! affect a runnable task while the planner still holds the language dependency graph, failing
//! closed (`cacheable = false`) whenever closure soundness cannot be guaranteed.

use super::PlanEvidence;
use super::widening_fs::FS_DIR_PREFIX;
use crate::graph::{DependencyGraph, GraphUncertainty, ModuleNode};
use crate::manifest::{DeclaredTask, ImpactMode, Project, TestingManifest};
use crate::protocol::{ResolvedScope, TaskCacheInputs};
use crate::scope::{deepest_project_for_path, path_is_inside, path_matches_impact};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

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
        for (idx, node) in nodes.iter().enumerate() {
            node_by_path.insert(node.path.as_str(), idx);
            let owner =
                deepest_project_for_path(&manifest.projects, &node.path).map(|p| p.id.as_str());
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
            || scope.full_fallback
            || evidence.full_fallback
            || (task.impact.mode == ImpactMode::Reachability && !self.has_graph)
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
        let Some((visited_nodes, dynamic_scope_paths, using_full_project)) =
            self.walk_forward_closure(&task.project, selected_files, setup_files)
        else {
            return uncacheable_inputs();
        };
        let mut seed_projects = BTreeSet::from([task.project.as_str()]);
        for &node_idx in &visited_nodes {
            if let Some(owner) = self.owner_by_node[node_idx] {
                seed_projects.insert(owner);
            }
        }
        let Some(project_roots) = expand_project_dependency_roots(
            &self.projects_by_id,
            self.unified_project_deps,
            &seed_projects,
            task.project.as_str(),
            using_full_project || !self.has_graph,
        ) else {
            return uncacheable_inputs();
        };
        let impact_paths = self.collect_impact_paths(task, dynamic_scope_paths);
        let mut extra_files: BTreeSet<String> = setup_files.iter().cloned().collect();
        for &node_idx in &visited_nodes {
            let path = &self.nodes[node_idx].path;
            if path.starts_with(FS_DIR_PREFIX) {
                continue;
            }
            if !project_roots.iter().any(|root| path_is_inside(path, root)) {
                extra_files.insert(path.clone());
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
    ) -> Option<(BTreeSet<usize>, BTreeSet<String>, bool)> {
        if !self.has_graph {
            return Some((BTreeSet::new(), BTreeSet::new(), true));
        }
        let (seeds, using_full_project) =
            collect_seed_modules(self, project_id, selected_files, setup_files);
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
        Some((visited_nodes, dynamic_scope_paths, using_full_project))
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

fn uncacheable_inputs() -> TaskCacheInputs {
    TaskCacheInputs {
        cacheable: false,
        project_roots: Vec::new(),
        impact_paths: Vec::new(),
        extra_files: Vec::new(),
    }
}

fn is_closure_breaking_uncertainty(
    uncertainty: &GraphUncertainty,
    dynamic_import_scopes: &BTreeMap<String, Vec<String>>,
    enforce_declared_reads: bool,
) -> bool {
    match uncertainty.code.as_str() {
        "unresolved-local-module"
        | "generated-or-virtual-module"
        | "javascript-parse-failed"
        | "javascript-semantic-failed"
        | "javascript-source-read-failed" => true,
        "nonliteral-dynamic-import" | "nonliteral-commonjs-require" => {
            !dynamic_import_scopes.contains_key(&uncertainty.path)
        }
        "unresolved-fs-read" => {
            !enforce_declared_reads && !dynamic_import_scopes.contains_key(&uncertainty.path)
        }
        _ => false,
    }
}

fn collect_seed_modules(
    index: &CacheInputIndex<'_>,
    project_id: &str,
    selected_files: &[String],
    setup_files: &[String],
) -> (Vec<usize>, bool) {
    if !selected_files.is_empty() {
        let mut seeds = Vec::with_capacity(selected_files.len() + setup_files.len());
        let mut all_present = true;
        for path in selected_files.iter().chain(setup_files.iter()) {
            if let Some(&idx) = index.node_by_path.get(path.as_str()) {
                seeds.push(idx);
            } else {
                all_present = false;
            }
        }
        if all_present {
            return (seeds, false);
        }
        if let Some(project_nodes) = index.nodes_by_project.get(project_id) {
            seeds.extend(project_nodes.iter().copied());
        }
        return (seeds, true);
    }
    let mut seeds = index
        .nodes_by_project
        .get(project_id)
        .cloned()
        .unwrap_or_default();
    for path in setup_files {
        if let Some(&idx) = index.node_by_path.get(path.as_str()) {
            seeds.push(idx);
        }
    }
    (seeds, true)
}

fn expand_project_dependency_roots<'a>(
    projects_by_id: &BTreeMap<&'a str, &'a Project>,
    unified_project_deps: &BTreeMap<&'a str, BTreeSet<&'a str>>,
    seed_projects: &BTreeSet<&'a str>,
    owner_project: &'a str,
    expand_owner_via_unified: bool,
) -> Option<BTreeSet<String>> {
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::new();
    let mut roots = BTreeSet::new();
    for &project_id in seed_projects {
        if visited.insert(project_id) {
            queue.push_back((project_id, false));
        }
    }
    while let Some((project_id, reached_via_fallback)) = queue.pop_front() {
        let project = projects_by_id.get(project_id)?;
        roots.insert(project.root.clone());
        for dep in &project.fallback_dependencies {
            if visited.insert(dep.as_str()) {
                queue.push_back((dep.as_str(), true));
            }
        }
        // If a project was pulled in via `fallbackDependencies` (not Oxc module traversal),
        // also include its Oxc dependencies so indirect `fallback -> Oxc` chains never go stale.
        let use_unified =
            reached_via_fallback || (expand_owner_via_unified && project_id == owner_project);
        if use_unified && let Some(deps) = unified_project_deps.get(project_id) {
            for &dep in deps {
                if visited.insert(dep) {
                    queue.push_back((dep, true));
                }
            }
        }
    }
    Some(roots)
}

fn snapshot_pattern_globs(prefix: &str, suffix: &str) -> Vec<String> {
    if prefix.ends_with('/') {
        if suffix.starts_with('/') {
            vec![format!("{prefix}**{suffix}")]
        } else {
            vec![format!("{prefix}**/*{suffix}")]
        }
    } else if suffix.starts_with('/') {
        vec![
            format!("{prefix}*{suffix}"),
            format!("{prefix}*/**{suffix}"),
        ]
    } else {
        vec![
            format!("{prefix}*{suffix}"),
            format!("{prefix}*/**/*{suffix}"),
        ]
    }
}
