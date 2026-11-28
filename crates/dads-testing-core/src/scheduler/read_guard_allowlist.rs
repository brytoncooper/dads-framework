//! Per-task workspace allowlist construction for the runtime file-read guard.
//!
//! Combines planner-computed `TaskCacheInputs`, manifest declarations (`impact.paths`,
//! `setupFiles`, `workspace.ignorePaths`, SQL roots), and a non-aborting forward graph walk
//! so `--all`, `audit`, and `--plan-file` all receive accurate allowlists without false positives.

use crate::discover_vitest::VITEST_CONFIG_CANDIDATES;
use crate::graph::{DependencyGraph, ImportKind, ModuleNode};
use crate::manifest::{DeclaredTask, Project, TestingManifest};
use crate::plan::cache_inputs_helpers::snapshot_pattern_globs;
use crate::plan::project_graph::unified_project_dependencies;
pub(super) use crate::protocol::TaskReadGuardAllowlist;
use crate::protocol::{TaskCacheInputs, TaskDecision};
use crate::scope::{deepest_project_for_path, path_is_inside, path_matches_impact};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

const FS_DIR_PREFIX: &str = "fs-dir:";

pub(crate) struct AllowlistBuilder<'a> {
    manifest: &'a TestingManifest,
    projects_by_id: BTreeMap<&'a str, &'a Project>,
    nodes: Cow<'a, [ModuleNode]>,
    node_by_path: HashMap<String, usize>,
    nodes_by_project: BTreeMap<&'a str, Vec<usize>>,
    owner_by_node: Vec<Option<&'a str>>,
    unified_project_deps: Cow<'a, BTreeMap<&'a str, BTreeSet<&'a str>>>,
    has_graph: bool,
}

impl<'a> AllowlistBuilder<'a> {
    pub(crate) fn new(manifest: &'a TestingManifest, graph: Option<&DependencyGraph>) -> Self {
        let nodes = graph.map_or_else(Vec::new, DependencyGraph::materialize_modules);
        let unified_project_deps = unified_project_dependencies(manifest, &nodes);
        Self::build(
            manifest,
            graph.is_some(),
            Cow::Owned(nodes),
            Cow::Owned(unified_project_deps),
        )
    }

    pub(crate) fn from_graph_parts(
        manifest: &'a TestingManifest,
        has_graph: bool,
        nodes: &'a [ModuleNode],
        unified_project_deps: &'a BTreeMap<&'a str, BTreeSet<&'a str>>,
    ) -> Self {
        Self::build(
            manifest,
            has_graph,
            Cow::Borrowed(nodes),
            Cow::Borrowed(unified_project_deps),
        )
    }

    fn build(
        manifest: &'a TestingManifest,
        has_graph: bool,
        nodes: Cow<'a, [ModuleNode]>,
        unified_project_deps: Cow<'a, BTreeMap<&'a str, BTreeSet<&'a str>>>,
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
            node_by_path.insert(node.path.clone(), idx);
            let owner =
                deepest_project_for_path(&manifest.projects, &node.path).map(|p| p.id.as_str());
            owner_by_node.push(owner);
            if let Some(proj_id) = owner {
                nodes_by_project.entry(proj_id).or_default().push(idx);
            }
        }
        Self {
            manifest,
            projects_by_id,
            nodes,
            node_by_path,
            nodes_by_project,
            owner_by_node,
            unified_project_deps,
            has_graph,
        }
    }

    pub(crate) fn for_task(
        &self,
        task: &DeclaredTask,
        decision: &TaskDecision,
    ) -> TaskReadGuardAllowlist {
        self.for_task_parts(
            task,
            &decision.selected_files,
            decision.cache_inputs.as_ref(),
        )
    }

    pub(crate) fn for_task_parts(
        &self,
        task: &DeclaredTask,
        selected_files: &[String],
        cache_inputs: Option<&TaskCacheInputs>,
    ) -> TaskReadGuardAllowlist {
        let owner_is_workspace_root = self
            .projects_by_id
            .get(task.project.as_str())
            .is_some_and(|project| is_workspace_root_path(&project.root));
        let mut project_roots = BTreeSet::new();
        let mut impact_paths = BTreeSet::new();
        let mut extra_files = BTreeSet::new();

        if let Some(cache_inputs) = cache_inputs {
            for root in &cache_inputs.project_roots {
                if owner_is_workspace_root || !is_workspace_root_path(root) {
                    project_roots.insert(root.clone());
                }
            }
            impact_paths.extend(cache_inputs.impact_paths.iter().cloned());
            for file in &cache_inputs.extra_files {
                if let Some(dir) = file.strip_prefix(FS_DIR_PREFIX) {
                    if !dir.is_empty() {
                        impact_paths.insert(dir.to_owned());
                    }
                } else {
                    extra_files.insert(file.clone());
                }
            }
        }

        impact_paths.extend(task.impact.paths.iter().cloned());
        impact_paths.extend(self.manifest.workspace.ignore_paths.iter().cloned());
        add_sql_impact_paths(self.manifest, task, &mut impact_paths);

        let setup_files: &[String] = task
            .execution
            .file_narrowing
            .as_ref()
            .map_or(&[], |narrowing| narrowing.setup_files.as_slice());
        extra_files.extend(setup_files.iter().cloned());

        let mut seed_projects = BTreeSet::from([task.project.as_str()]);
        let mut using_full_project = !self.has_graph;
        let mut visited_nodes = BTreeSet::new();
        let mut external_targets = BTreeSet::new();

        if self.has_graph {
            let walk = self.walk_forward_best_effort(
                task,
                selected_files,
                setup_files,
                &mut impact_paths,
                &mut external_targets,
            );
            visited_nodes = walk.0;
            using_full_project = walk.1;
            for &idx in &visited_nodes {
                if let Some(owner) = self.owner_by_node[idx] {
                    let is_catch_all_root = owner != task.project
                        && self
                            .projects_by_id
                            .get(owner)
                            .is_some_and(|p| is_workspace_root_path(&p.root));
                    if !is_catch_all_root {
                        seed_projects.insert(owner);
                    }
                }
            }
        }

        self.expand_project_roots(
            &seed_projects,
            &task.project,
            owner_is_workspace_root,
            using_full_project,
            &mut project_roots,
        );

        for idx in visited_nodes {
            let path = &self.nodes[idx].path;
            if !path.starts_with(FS_DIR_PREFIX)
                && !project_roots.iter().any(|root| path_is_inside(path, root))
            {
                extra_files.insert(path.clone());
            }
        }
        for target in external_targets {
            if !project_roots
                .iter()
                .any(|root| path_is_inside(&target, root))
            {
                extra_files.insert(target);
            }
        }

        let ancestor_dirs = collect_ancestor_dirs(&project_roots);
        TaskReadGuardAllowlist {
            allowed_project_roots: project_roots.into_iter().collect(),
            allowed_impact_paths: impact_paths.into_iter().collect(),
            allowed_extra_files: extra_files.into_iter().collect(),
            allowed_ancestor_dirs: ancestor_dirs.into_iter().collect(),
        }
    }

    fn walk_forward_best_effort(
        &self,
        task: &DeclaredTask,
        selected_files: &[String],
        setup_files: &[String],
        impact_paths: &mut BTreeSet<String>,
        external_targets: &mut BTreeSet<String>,
    ) -> (BTreeSet<usize>, bool) {
        let (seeds, using_full_project) = self.collect_seeds(task, selected_files, setup_files);
        let mut visited = BTreeSet::new();
        let mut queue = VecDeque::new();
        for idx in seeds {
            if visited.insert(idx) {
                queue.push_back(idx);
            }
        }
        while let Some(node_idx) = queue.pop_front() {
            let node = &self.nodes[node_idx];
            if let Some(dir) = node.path.strip_prefix(FS_DIR_PREFIX) {
                if !dir.is_empty() {
                    impact_paths.insert(dir.to_owned());
                }
                continue;
            }
            if let Some(prefixes) = self
                .manifest
                .workspace
                .dynamic_import_scopes
                .get(&node.path)
            {
                impact_paths.extend(prefixes.iter().cloned());
                for (candidate_idx, candidate) in self.nodes.iter().enumerate() {
                    if !visited.contains(&candidate_idx)
                        && prefixes
                            .iter()
                            .any(|prefix| path_matches_impact(&candidate.path, prefix))
                        && visited.insert(candidate_idx)
                    {
                        queue.push_back(candidate_idx);
                    }
                }
            }
            for imp in &node.imports {
                let Some(target) = imp.resolved_path.as_deref() else {
                    continue;
                };
                if let Some(dir) = target.strip_prefix(FS_DIR_PREFIX) {
                    if !dir.is_empty() {
                        impact_paths.insert(dir.to_owned());
                    }
                    continue;
                }
                if imp.kind == ImportKind::FileRead {
                    if let Some(dir) = target.strip_suffix('/') {
                        if !dir.is_empty() {
                            impact_paths.insert(dir.to_owned());
                        }
                    } else {
                        external_targets.insert(target.to_owned());
                    }
                    continue;
                }
                if let Some(&target_idx) = self.node_by_path.get(target) {
                    if visited.insert(target_idx) {
                        queue.push_back(target_idx);
                    }
                } else {
                    external_targets.insert(target.to_owned());
                }
            }
        }
        (visited, using_full_project)
    }

    fn collect_seeds(
        &self,
        task: &DeclaredTask,
        selected_files: &[String],
        setup_files: &[String],
    ) -> (Vec<usize>, bool) {
        let project_id = task.project.as_str();
        if !selected_files.is_empty() {
            let mut seeds = Vec::with_capacity(selected_files.len() + setup_files.len() + 2);
            let mut all_present = true;
            for path in selected_files.iter().chain(setup_files.iter()) {
                if let Some(&idx) = self.node_by_path.get(path.as_str()) {
                    seeds.push(idx);
                } else {
                    all_present = false;
                }
            }
            if let Some(project) = self.projects_by_id.get(project_id) {
                let root_prefix = project.root.trim_end_matches('/');
                for candidate in VITEST_CONFIG_CANDIDATES {
                    let full = if is_workspace_root_path(root_prefix) {
                        (*candidate).to_owned()
                    } else {
                        format!("{root_prefix}/{candidate}")
                    };
                    if let Some(&idx) = self.node_by_path.get(&full) {
                        seeds.push(idx);
                    }
                }
                if !is_workspace_root_path(root_prefix) {
                    for impact_path in &task.impact.paths {
                        if path_is_inside(impact_path, root_prefix)
                            && let Some(&idx) = self.node_by_path.get(impact_path.as_str())
                        {
                            seeds.push(idx);
                        }
                    }
                }
            }
            if all_present {
                return (seeds, false);
            }
            if let Some(project_nodes) = self.nodes_by_project.get(project_id) {
                seeds.extend(project_nodes.iter().copied());
            }
            return (seeds, true);
        }
        let mut seeds = self
            .nodes_by_project
            .get(project_id)
            .cloned()
            .unwrap_or_default();
        for path in setup_files {
            if let Some(&idx) = self.node_by_path.get(path.as_str()) {
                seeds.push(idx);
            }
        }
        (seeds, true)
    }

    fn expand_project_roots(
        &self,
        seed_projects: &BTreeSet<&str>,
        owner_project: &str,
        owner_is_workspace_root: bool,
        expand_owner_via_unified: bool,
        project_roots: &mut BTreeSet<String>,
    ) {
        let mut visited: BTreeSet<&str> = BTreeSet::new();
        let mut queue: VecDeque<(&str, bool)> = VecDeque::new();
        for &project_id in seed_projects {
            if visited.insert(project_id) {
                queue.push_back((project_id, false));
            }
        }
        while let Some((project_id, reached_via_fallback)) = queue.pop_front() {
            let Some(project) = self.projects_by_id.get(project_id) else {
                continue;
            };
            if is_workspace_root_path(&project.root) && !owner_is_workspace_root {
                continue;
            }
            project_roots.insert(project.root.clone());
            for dep in &project.fallback_dependencies {
                if visited.insert(dep.as_str()) {
                    queue.push_back((dep.as_str(), true));
                }
            }
            let use_unified =
                reached_via_fallback || (expand_owner_via_unified && project_id == owner_project);
            if use_unified && let Some(deps) = self.unified_project_deps.get(project_id) {
                for &dep in deps {
                    if visited.insert(dep) {
                        queue.push_back((dep, true));
                    }
                }
            }
        }
    }
}

fn is_workspace_root_path(root: &str) -> bool {
    let trimmed = root.trim_start_matches("./").trim_end_matches('/');
    trimmed.is_empty() || trimmed == "."
}

fn add_sql_impact_paths(
    manifest: &TestingManifest,
    task: &DeclaredTask,
    impact_paths: &mut BTreeSet<String>,
) {
    let (Some(_), Some(sql)) = (&task.sql_impact, &manifest.workspace.sql) else {
        return;
    };
    for root in &sql.migration_roots {
        let trimmed = root.trim_end_matches('/');
        if !trimmed.is_empty() {
            impact_paths.insert(trimmed.to_owned());
        }
    }
    for pattern in &sql.snapshot_patterns {
        impact_paths.extend(snapshot_pattern_globs(&pattern.prefix, &pattern.suffix));
    }
}

fn collect_ancestor_dirs(project_roots: &BTreeSet<String>) -> BTreeSet<String> {
    let mut ancestors = BTreeSet::new();
    for root in project_roots {
        let mut cursor = root.trim_end_matches('/');
        if cursor.is_empty() || cursor == "." {
            continue;
        }
        while let Some((parent, _)) = cursor.rsplit_once('/') {
            if parent.is_empty() {
                break;
            }
            ancestors.insert(parent.to_owned());
            cursor = parent;
        }
    }
    ancestors
}
