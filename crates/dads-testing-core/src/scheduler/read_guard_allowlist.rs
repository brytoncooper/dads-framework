//! Per-task workspace allowlist construction for the runtime file-read guard.
//!
//! Combines planner-computed `TaskCacheInputs`, manifest declarations (`impact.paths`,
//! `setupFiles`, `workspace.ignorePaths`, SQL roots), and a non-aborting forward graph walk
//! so `--all`, `audit`, and `--plan-file` all receive accurate allowlists without false positives.

use crate::graph::{DependencyGraph, ModuleNode};
use crate::manifest::{DeclaredTask, Project, TestingManifest};
use crate::plan::project_graph::unified_project_dependencies;
use crate::protocol::TaskDecision;
use crate::scope::{deepest_project_for_path, path_is_inside, path_matches_impact};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

const FS_DIR_PREFIX: &str = "fs-dir:";

#[derive(Debug, Clone, Default)]
pub(super) struct TaskReadGuardAllowlist {
    pub(super) allowed_project_roots: Vec<String>,
    pub(super) allowed_impact_paths: Vec<String>,
    pub(super) allowed_extra_files: Vec<String>,
    pub(super) allowed_ancestor_dirs: Vec<String>,
}

impl TaskReadGuardAllowlist {
    /// Unions multiple task allowlists (used when a Vitest batch executes tasks together in
    /// enforce mode; any violation triggers isolated per-task re-execution for exact attribution).
    pub(super) fn merge_many<'a>(lists: impl IntoIterator<Item = &'a Self>) -> Self {
        let mut project_roots = BTreeSet::new();
        let mut impact_paths = BTreeSet::new();
        let mut extra_files = BTreeSet::new();
        let mut ancestor_dirs = BTreeSet::new();
        for list in lists {
            project_roots.extend(list.allowed_project_roots.iter().cloned());
            impact_paths.extend(list.allowed_impact_paths.iter().cloned());
            extra_files.extend(list.allowed_extra_files.iter().cloned());
            ancestor_dirs.extend(list.allowed_ancestor_dirs.iter().cloned());
        }
        Self {
            allowed_project_roots: project_roots.into_iter().collect(),
            allowed_impact_paths: impact_paths.into_iter().collect(),
            allowed_extra_files: extra_files.into_iter().collect(),
            allowed_ancestor_dirs: ancestor_dirs.into_iter().collect(),
        }
    }
}

pub(super) struct AllowlistBuilder<'a> {
    manifest: &'a TestingManifest,
    projects_by_id: BTreeMap<&'a str, &'a Project>,
    nodes: Vec<ModuleNode>,
    node_by_path: HashMap<String, usize>,
    nodes_by_project: BTreeMap<&'a str, Vec<usize>>,
    owner_by_node: Vec<Option<&'a str>>,
    unified_project_deps: BTreeMap<&'a str, BTreeSet<&'a str>>,
    has_graph: bool,
}

impl<'a> AllowlistBuilder<'a> {
    pub(super) fn new(manifest: &'a TestingManifest, graph: Option<&DependencyGraph>) -> Self {
        let projects_by_id: BTreeMap<&'a str, &'a Project> = manifest
            .projects
            .iter()
            .map(|project| (project.id.as_str(), project))
            .collect();
        let nodes = graph.map_or_else(Vec::new, DependencyGraph::materialize_modules);
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
        let unified_project_deps = unified_project_dependencies(manifest, &nodes);
        Self {
            manifest,
            projects_by_id,
            nodes,
            node_by_path,
            nodes_by_project,
            owner_by_node,
            unified_project_deps,
            has_graph: graph.is_some(),
        }
    }

    pub(super) fn for_task(
        &self,
        task: &DeclaredTask,
        decision: &TaskDecision,
    ) -> TaskReadGuardAllowlist {
        let mut project_roots = BTreeSet::new();
        let mut impact_paths = BTreeSet::new();
        let mut extra_files = BTreeSet::new();

        if let Some(cache_inputs) = decision.cache_inputs.as_ref() {
            project_roots.extend(cache_inputs.project_roots.iter().cloned());
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
                &task.project,
                &decision.selected_files,
                setup_files,
                &mut impact_paths,
                &mut external_targets,
            );
            visited_nodes = walk.0;
            using_full_project = walk.1;
            for &idx in &visited_nodes {
                if let Some(owner) = self.owner_by_node[idx] {
                    seed_projects.insert(owner);
                }
            }
        }

        self.expand_project_roots(
            &seed_projects,
            &task.project,
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
        project_id: &str,
        selected_files: &[String],
        setup_files: &[String],
        impact_paths: &mut BTreeSet<String>,
        external_targets: &mut BTreeSet<String>,
    ) -> (BTreeSet<usize>, bool) {
        let (seeds, using_full_project) =
            self.collect_seeds(project_id, selected_files, setup_files);
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
        project_id: &str,
        selected_files: &[String],
        setup_files: &[String],
    ) -> (Vec<usize>, bool) {
        if !selected_files.is_empty() {
            let mut seeds = Vec::with_capacity(selected_files.len() + setup_files.len());
            let mut all_present = true;
            for path in selected_files.iter().chain(setup_files.iter()) {
                if let Some(&idx) = self.node_by_path.get(path.as_str()) {
                    seeds.push(idx);
                } else {
                    all_present = false;
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

fn add_sql_impact_paths(
    manifest: &TestingManifest,
    task: &DeclaredTask,
    impact_paths: &mut BTreeSet<String>,
) {
    let (Some(_), Some(sql)) = (&task.sql_impact, &manifest.workspace.sql) else {
        return;
    };
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
        if pattern.prefix.ends_with('/') {
            if pattern.suffix.starts_with('/') {
                impact_paths.insert(format!("{}**{}", pattern.prefix, pattern.suffix));
            } else {
                impact_paths.insert(format!("{}**/*{}", pattern.prefix, pattern.suffix));
            }
        } else if pattern.suffix.starts_with('/') {
            impact_paths.insert(format!("{}*{}", pattern.prefix, pattern.suffix));
            impact_paths.insert(format!("{}*/**{}", pattern.prefix, pattern.suffix));
        } else {
            impact_paths.insert(format!("{}*{}", pattern.prefix, pattern.suffix));
            impact_paths.insert(format!("{}*/**/*{}", pattern.prefix, pattern.suffix));
        }
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
