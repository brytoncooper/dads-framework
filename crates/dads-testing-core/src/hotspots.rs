//! Blast-radius hotspot analysis: ranks source files, barrel re-export hubs, and projects by
//! reverse-reachable impact across the workspace import graph.
use crate::graph::{DependencyGraph, ImportKind, ModuleNode};
use crate::manifest::{FileNarrowing, TestingManifest};
use crate::protocol::PROTOCOL_SCHEMA_VERSION;
use crate::scope::{deepest_project_for_path, is_test_module_with_narrowings};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HotspotsOptions {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub min_projects: Option<usize>,
    #[serde(default)]
    pub barrels_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotspotsResult {
    pub schema_version: u32,
    pub summary: HotspotsSummary,
    pub files: Vec<HotspotFile>,
    pub projects: Vec<HotspotProject>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotspotsSummary {
    pub total_files: usize,
    pub total_barrels: usize,
    pub total_projects: usize,
    pub limit: usize,
    pub min_projects: usize,
    pub barrels_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotspotFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub affected_projects: usize,
    pub affected_files: usize,
    pub direct_importers: usize,
    pub is_barrel: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotspotProject {
    pub project: String,
    pub affected_projects: usize,
    pub affected_files: usize,
    pub direct_dependent_projects: usize,
    pub file_count: usize,
    pub barrel_count: usize,
}

pub(crate) const DEFAULT_HOTSPOTS_LIMIT: usize = 25;
pub(crate) const DEFAULT_HOTSPOTS_MIN_PROJECTS: usize = 1;

struct IndexedModule {
    path: String,
    project: Option<usize>,
    is_test: bool,
    is_barrel: bool,
    importers: Vec<usize>,
}

pub(crate) fn build_hotspots(
    manifest: &TestingManifest,
    graph: Option<&DependencyGraph>,
    options: Option<&HotspotsOptions>,
) -> HotspotsResult {
    let limit = options
        .and_then(|opt| opt.limit)
        .unwrap_or(DEFAULT_HOTSPOTS_LIMIT);
    let min_projects = options
        .and_then(|opt| opt.min_projects)
        .unwrap_or(DEFAULT_HOTSPOTS_MIN_PROJECTS);
    let barrels_only = options.is_some_and(|opt| opt.barrels_only);

    let mods = index_modules(manifest, graph);
    let total_files = mods.iter().filter(|m| !m.is_test).count();
    let total_barrels = mods.iter().filter(|m| !m.is_test && m.is_barrel).count();

    let files = rank_file_hotspots(manifest, &mods, limit, min_projects, barrels_only);
    let projects = rank_project_hotspots(manifest, &mods, limit, min_projects);

    HotspotsResult {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        summary: HotspotsSummary {
            total_files,
            total_barrels,
            total_projects: manifest.projects.len(),
            limit,
            min_projects,
            barrels_only,
        },
        files,
        projects,
    }
}

fn index_modules(
    manifest: &TestingManifest,
    graph: Option<&DependencyGraph>,
) -> Vec<IndexedModule> {
    let proj_by_id: HashMap<&str, usize> = manifest
        .projects
        .iter()
        .enumerate()
        .map(|(i, p)| (p.id.as_str(), i))
        .collect();
    let narrowings: Vec<&FileNarrowing> = manifest
        .tasks
        .iter()
        .filter_map(|t| t.execution.file_narrowing.as_ref())
        .collect();
    let nodes = graph.map_or_else(Vec::new, DependencyGraph::materialize_modules);
    let mut by_path = HashMap::with_capacity(nodes.len());
    let mut mods = Vec::with_capacity(nodes.len());

    for (i, node) in nodes.iter().enumerate() {
        by_path.insert(node.path.as_str(), i);
        let project = deepest_project_for_path(&manifest.projects, &node.path)
            .and_then(|p| proj_by_id.get(p.id.as_str()).copied());
        let is_test = is_test_module_with_narrowings(&node.path, &narrowings);
        let is_barrel = !is_test && is_barrel_module(node);
        mods.push(IndexedModule {
            path: node.path.clone(),
            project,
            is_test,
            is_barrel,
            importers: Vec::new(),
        });
    }

    for (imp_i, node) in nodes.iter().enumerate() {
        for imp in &node.imports {
            if imp.kind == ImportKind::FileRead {
                continue;
            }
            let Some(&target_i) = imp.resolved_path.as_deref().and_then(|p| by_path.get(p)) else {
                continue;
            };
            if target_i == imp_i {
                continue;
            }
            if !mods[target_i].importers.contains(&imp_i) {
                mods[target_i].importers.push(imp_i);
            }
        }
    }

    mods
}

/// Identifies whether a module is primarily a re-export hub (barrel file).
///
/// Re-export forwarding declarations (`export { foo } from "./a"` or `import { a } from "./a";
/// export { a };`) appear in `ModuleNode.declarations`, so they are separated from local
/// implementation declarations before classifying the file.
pub(crate) fn is_barrel_module(node: &ModuleNode) -> bool {
    let reexport_imports: Vec<_> = node
        .imports
        .iter()
        .filter(|imp| imp.kind == ImportKind::ReExport)
        .collect();
    let imported_names: HashSet<&str> = node.references.iter().map(|r| r.name.as_str()).collect();

    let mut imported_reexports = 0usize;
    let mut local_declarations = 0usize;
    for decl in &node.declarations {
        let forwards_reexport = reexport_imports
            .iter()
            .any(|imp| decl.span.start <= imp.span.start && imp.span.end <= decl.span.end);
        if forwards_reexport {
            continue;
        }
        if imported_names.contains(decl.name.as_str()) {
            imported_reexports += 1;
        } else {
            local_declarations += 1;
        }
    }

    let reexport_count = reexport_imports.len() + imported_reexports;
    if reexport_count == 0 {
        return false;
    }
    if local_declarations == 0 {
        return true;
    }
    let has_reexport_all = reexport_imports
        .iter()
        .any(|imp| imp.reexport_all || imp.reexport_namespace.is_some());
    let is_index = is_index_filename(&node.path);
    (is_index || has_reexport_all) && reexport_count >= local_declarations
}

fn is_index_filename(path: &str) -> bool {
    Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem == "index")
}

fn rank_file_hotspots(
    manifest: &TestingManifest,
    mods: &[IndexedModule],
    limit: usize,
    min_projects: usize,
    barrels_only: bool,
) -> Vec<HotspotFile> {
    let mut seen_m = vec![0u32; mods.len()];
    let mut seen_p = vec![0u32; manifest.projects.len()];
    let mut queue = VecDeque::new();
    let mut epoch = 0u32;
    let mut files = Vec::new();

    for (i, module) in mods.iter().enumerate() {
        if module.is_test || (barrels_only && !module.is_barrel) {
            continue;
        }
        epoch += 1;
        queue.clear();
        seen_m[i] = epoch;
        queue.push_back(i);
        let mut affected_files = 0usize;
        let mut affected_projects = 0usize;

        while let Some(current) = queue.pop_front() {
            affected_files += 1;
            if let Some(p) = mods[current].project
                && seen_p[p] != epoch
            {
                seen_p[p] = epoch;
                affected_projects += 1;
            }
            for &importer in &mods[current].importers {
                if seen_m[importer] != epoch {
                    seen_m[importer] = epoch;
                    queue.push_back(importer);
                }
            }
        }

        if affected_projects < min_projects {
            continue;
        }
        files.push(HotspotFile {
            path: module.path.clone(),
            project: module.project.map(|p| manifest.projects[p].id.clone()),
            affected_projects,
            affected_files,
            direct_importers: module.importers.len(),
            is_barrel: module.is_barrel,
        });
    }

    files.sort_by(|a, b| {
        b.affected_projects
            .cmp(&a.affected_projects)
            .then_with(|| b.affected_files.cmp(&a.affected_files))
            .then_with(|| b.direct_importers.cmp(&a.direct_importers))
            .then_with(|| a.path.cmp(&b.path))
    });
    files.truncate(limit);
    files
}

fn rank_project_hotspots(
    manifest: &TestingManifest,
    mods: &[IndexedModule],
    limit: usize,
    min_projects: usize,
) -> Vec<HotspotProject> {
    let proj_count = manifest.projects.len();
    let mut source_mods_by_proj = vec![Vec::new(); proj_count];
    let mut barrel_counts = vec![0usize; proj_count];
    for (i, module) in mods.iter().enumerate() {
        if module.is_test {
            continue;
        }
        if let Some(p) = module.project {
            source_mods_by_proj[p].push(i);
            if module.is_barrel {
                barrel_counts[p] += 1;
            }
        }
    }

    let mut seen_m = vec![0u32; mods.len()];
    let mut seen_p = vec![0u32; proj_count];
    let mut seen_direct_p = vec![0u32; proj_count];
    let mut queue = VecDeque::new();
    let mut epoch = 0u32;
    let mut projects = Vec::new();

    for (p, project) in manifest.projects.iter().enumerate() {
        let seeds = &source_mods_by_proj[p];
        if seeds.is_empty() {
            continue;
        }
        epoch += 1;
        queue.clear();
        let mut direct_dependent_projects = 0usize;
        for &seed in seeds {
            if seen_m[seed] != epoch {
                seen_m[seed] = epoch;
                queue.push_back(seed);
            }
            for &importer in &mods[seed].importers {
                if let Some(imp_p) = mods[importer].project
                    && imp_p != p
                    && seen_direct_p[imp_p] != epoch
                {
                    seen_direct_p[imp_p] = epoch;
                    direct_dependent_projects += 1;
                }
            }
        }

        let mut affected_files = 0usize;
        let mut affected_projects = 0usize;
        while let Some(current) = queue.pop_front() {
            affected_files += 1;
            if let Some(cur_p) = mods[current].project
                && seen_p[cur_p] != epoch
            {
                seen_p[cur_p] = epoch;
                affected_projects += 1;
            }
            for &importer in &mods[current].importers {
                if seen_m[importer] != epoch {
                    seen_m[importer] = epoch;
                    queue.push_back(importer);
                }
            }
        }

        if affected_projects < min_projects {
            continue;
        }
        projects.push(HotspotProject {
            project: project.id.clone(),
            affected_projects,
            affected_files,
            direct_dependent_projects,
            file_count: seeds.len(),
            barrel_count: barrel_counts[p],
        });
    }

    projects.sort_by(|a, b| {
        b.affected_projects
            .cmp(&a.affected_projects)
            .then_with(|| b.affected_files.cmp(&a.affected_files))
            .then_with(|| {
                b.direct_dependent_projects
                    .cmp(&a.direct_dependent_projects)
            })
            .then_with(|| a.project.cmp(&b.project))
    });
    projects.truncate(limit);
    projects
}
