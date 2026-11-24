//! Read-only coupling and precision X-ray: indexes the dependency graph and ranks widening
//! culprits, delegating reachability and fallback-trap passes to sibling modules.
use crate::diagnose_reachability::analyze_reachability;
use crate::diagnose_remediation::{culprit_remediation, is_tool_config_file};
use crate::diagnose_traps::find_fallback_traps;
use crate::graph::{DependencyGraph, GraphUncertainty, GraphUncertaintyScope};
use crate::manifest::{FileNarrowing, ImpactMode, TestingManifest};
use crate::protocol::{
    DiagnoseResult, DiagnoseSummary, IssueScope, PROTOCOL_SCHEMA_VERSION, WideningCulprit,
};
use crate::scope::{
    deepest_project_for_path, is_standard_test_path, is_test_module_with_narrowings,
    path_matches_impact,
};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::path::Path;

#[derive(Clone, Copy)]
pub(crate) enum UncertaintyTarget {
    Closure(usize),
    LocalProject(usize),
    FullFallback,
}

pub(crate) struct ModNode {
    pub(crate) path: String,
    pub(crate) project: Option<usize>,
    pub(crate) is_test: bool,
    pub(crate) runtime_deps: Vec<usize>,
    pub(crate) all_deps: Vec<usize>,
    pub(crate) runtime_importers: Vec<usize>,
    pub(crate) all_importers: Vec<usize>,
    pub(crate) module_uncertainty_targets: Vec<UncertaintyTarget>,
}

pub(crate) struct WorkspaceIndex<'a> {
    pub(crate) proj_by_id: HashMap<&'a str, usize>,
    pub(crate) reach_projs: BTreeSet<usize>,
    pub(crate) reach_tasks: Vec<usize>,
    pub(crate) closures: Vec<BTreeSet<usize>>,
    pub(crate) mods: Vec<ModNode>,
    pub(crate) tests_by_proj: Vec<usize>,
    pub(crate) total_tests: usize,
    pub(crate) uncertainties: Vec<GraphUncertainty>,
    pub(crate) whole_ws_owned_widened: BTreeSet<usize>,
    pub(crate) has_unowned_whole_ws: bool,
    pub(crate) whole_ws_count: usize,
}

pub(crate) fn build_diagnose(
    manifest: &TestingManifest,
    workspace_root: &Path,
    graph: Option<&DependencyGraph>,
) -> DiagnoseResult {
    let idx = build_index(manifest, graph);
    let (effective_skip, potential_skip, hotspots) = analyze_reachability(manifest, &idx);
    let (unowned, uncovered, traps) = find_fallback_traps(manifest, &idx, workspace_root, graph);
    DiagnoseResult {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        summary: DiagnoseSummary {
            total_modules: idx.mods.len(),
            total_projects: manifest.projects.len(),
            total_tasks: manifest.tasks.len(),
            total_test_files: idx.total_tests,
            total_uncertainties: idx.uncertainties.len(),
            whole_workspace_uncertainties: idx.whole_ws_count,
            unowned_tracked_files: unowned,
            non_code_uncovered_files: uncovered,
            estimated_leaf_skip_percent: effective_skip,
            potential_leaf_skip_percent: potential_skip,
        },
        widening_culprits: rank_culprits(manifest, &idx),
        coupling_hotspots: hotspots,
        fallback_traps: traps,
    }
}

fn build_index<'a>(
    manifest: &'a TestingManifest,
    graph: Option<&DependencyGraph>,
) -> WorkspaceIndex<'a> {
    let n = manifest.projects.len();
    let proj_by_id: HashMap<&str, usize> = manifest
        .projects
        .iter()
        .enumerate()
        .map(|(i, p)| (p.id.as_str(), i))
        .collect();
    let (mut reach_projs, mut reach_tasks) = (BTreeSet::new(), vec![0; n]);
    for t in &manifest.tasks {
        if t.impact.mode == ImpactMode::Reachability
            && let Some(&i) = proj_by_id.get(t.project.as_str())
        {
            reach_projs.insert(i);
            reach_tasks[i] += 1;
        }
    }
    let closures = compute_closures(manifest, &proj_by_id);
    let nodes = graph.map_or_else(Vec::new, DependencyGraph::materialize_modules);
    let narrowings: Vec<&FileNarrowing> = manifest
        .tasks
        .iter()
        .filter_map(|t| t.execution.file_narrowing.as_ref())
        .collect();
    let (mut by_path, mut tests_by_proj, mut total_tests) =
        (HashMap::with_capacity(nodes.len()), vec![0; n], 0);
    let mut mods = Vec::with_capacity(nodes.len());
    for (i, node) in nodes.iter().enumerate() {
        by_path.insert(node.path.as_str(), i);
        let project = deepest_project_for_path(&manifest.projects, &node.path)
            .and_then(|p| proj_by_id.get(p.id.as_str()).copied());
        let is_test = is_test_module_with_narrowings(&node.path, &narrowings);
        total_tests += usize::from(is_test);
        if is_test && let Some(p) = project {
            tests_by_proj[p] += 1;
        }
        mods.push(ModNode {
            path: node.path.clone(),
            project,
            is_test,
            runtime_deps: Vec::new(),
            all_deps: Vec::new(),
            runtime_importers: Vec::new(),
            all_importers: Vec::new(),
            module_uncertainty_targets: Vec::new(),
        });
    }
    wire_edges(&nodes, &by_path, &mut mods);
    let uncertainties = graph.map_or_else(Vec::new, DependencyGraph::uncertainties);
    let (mut whole_ws_count, mut has_unowned_whole_ws) = (0, false);
    let mut whole_ws_owned_widened = BTreeSet::new();
    for u in &uncertainties {
        let owner = deepest_project_for_path(&manifest.projects, &u.path)
            .and_then(|p| proj_by_id.get(p.id.as_str()).copied());
        let local_only = is_local_test_uncertainty(&u.path, &by_path, &mods);
        let target = match owner {
            Some(p) if local_only => UncertaintyTarget::LocalProject(p),
            Some(p) => UncertaintyTarget::Closure(p),
            None => UncertaintyTarget::FullFallback,
        };
        if u.scope == GraphUncertaintyScope::WholeWorkspace {
            if let Some(prefixes) = manifest.workspace.dynamic_import_scopes.get(&u.path) {
                for m in &mut mods {
                    if m.path == u.path || prefixes.iter().any(|p| path_matches_impact(&m.path, p)) {
                        m.module_uncertainty_targets.push(target);
                    }
                }
                continue;
            }
            whole_ws_count += 1;
            match target {
                UncertaintyTarget::LocalProject(p) => {
                    whole_ws_owned_widened.insert(p);
                }
                UncertaintyTarget::Closure(p) => {
                    whole_ws_owned_widened.extend(closures[p].iter().copied());
                }
                UncertaintyTarget::FullFallback => has_unowned_whole_ws = true,
            }
        } else if let Some(&m_i) = by_path.get(u.path.as_str()) {
            mods[m_i].module_uncertainty_targets.push(target);
        }
    }
    WorkspaceIndex {
        proj_by_id,
        reach_projs,
        reach_tasks,
        closures,
        mods,
        tests_by_proj,
        total_tests,
        uncertainties,
        whole_ws_owned_widened,
        has_unowned_whole_ws,
        whole_ws_count,
    }
}

fn wire_edges(
    nodes: &[crate::graph::ModuleNode],
    by_path: &HashMap<&str, usize>,
    mods: &mut [ModNode],
) {
    for (imp_i, node) in nodes.iter().enumerate() {
        for imp in &node.imports {
            let Some(&t_i) = imp.resolved_path.as_deref().and_then(|p| by_path.get(p)) else {
                continue;
            };
            push_unique(&mut mods[imp_i].all_deps, t_i);
            push_unique(&mut mods[t_i].all_importers, imp_i);
            if !imp.type_only {
                push_unique(&mut mods[imp_i].runtime_deps, t_i);
                push_unique(&mut mods[t_i].runtime_importers, imp_i);
            }
        }
    }
}

fn push_unique(list: &mut Vec<usize>, value: usize) {
    if !list.contains(&value) {
        list.push(value);
    }
}

fn compute_closures(
    manifest: &TestingManifest,
    by_id: &HashMap<&str, usize>,
) -> Vec<BTreeSet<usize>> {
    let mut rev = vec![Vec::new(); manifest.projects.len()];
    for (i, p) in manifest.projects.iter().enumerate() {
        for dep in &p.fallback_dependencies {
            if let Some(&d) = by_id.get(dep.as_str()) {
                rev[d].push(i);
            }
        }
    }
    (0..rev.len())
        .map(|s| {
            let (mut seen, mut q) = (BTreeSet::from([s]), VecDeque::from([s]));
            while let Some(c) = q.pop_front() {
                q.extend(rev[c].iter().copied().filter(|&nx| seen.insert(nx)));
            }
            seen
        })
        .collect()
}

fn is_local_test_uncertainty(path: &str, by_path: &HashMap<&str, usize>, mods: &[ModNode]) -> bool {
    let Some(&m_i) = by_path.get(path) else {
        return false;
    };
    (mods[m_i].is_test || is_standard_test_path(path)) && mods[m_i].all_importers.is_empty()
}

fn rank_culprits(manifest: &TestingManifest, idx: &WorkspaceIndex<'_>) -> Vec<WideningCulprit> {
    let by_path: HashMap<&str, usize> = idx
        .mods
        .iter()
        .enumerate()
        .map(|(i, m)| (m.path.as_str(), i))
        .collect();
    let mut out = Vec::with_capacity(idx.uncertainties.len());
    for u in &idx.uncertainties {
        if u.code == "ambiguous-default-export" && is_tool_config_file(&u.path) {
            continue;
        }
        let scoped = u.scope == GraphUncertaintyScope::WholeWorkspace
            && manifest
                .workspace
                .dynamic_import_scopes
                .contains_key(&u.path);
        let owner = deepest_project_for_path(&manifest.projects, &u.path);
        let owner_i = owner.and_then(|p| idx.proj_by_id.get(p.id.as_str()).copied());
        let local_only = is_local_test_uncertainty(&u.path, &by_path, &idx.mods);
        let ws = u.scope == GraphUncertaintyScope::WholeWorkspace && !scoped;
        let (wp, wt, wf) = match owner_i {
            Some(i) if local_only => (1, idx.reach_tasks[i], idx.tests_by_proj[i]),
            Some(i) => {
                let s = &idx.closures[i];
                let (t, f) = s.iter().fold((0, 0), |(t, f), &p| {
                    (t + idx.reach_tasks[p], f + idx.tests_by_proj[p])
                });
                (s.len(), t, f)
            }
            None => (
                manifest.projects.len(),
                manifest.tasks.len(),
                idx.total_tests,
            ),
        };
        let pos = u.location.as_ref().map(|l| l.position);
        out.push(WideningCulprit {
            remediation: culprit_remediation(&u.code, &u.path),
            code: u.code.clone(),
            path: u.path.clone(),
            line: pos.map(|p| p.line),
            column: pos.map(|p| p.column),
            scope: if ws {
                IssueScope::Workspace
            } else {
                IssueScope::Module
            },
            project: owner.map(|p| p.id.clone()),
            message: u.message.clone(),
            widened_projects: wp,
            widened_tasks: wt,
            widened_test_files: wf,
        });
    }
    let is_ws = |c: &WideningCulprit| c.scope == IssueScope::Workspace;
    out.sort_by(|a, b| {
        b.widened_test_files
            .cmp(&a.widened_test_files)
            .then_with(|| b.widened_tasks.cmp(&a.widened_tasks))
            .then_with(|| b.widened_projects.cmp(&a.widened_projects))
            .then_with(|| is_ws(b).cmp(&is_ws(a)))
            .then_with(|| {
                (&a.path, a.line, a.column, &a.code).cmp(&(&b.path, b.line, b.column, &b.code))
            })
    });
    out.truncate(50);
    out
}
