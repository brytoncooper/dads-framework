//! Read-only coupling and precision X-ray: ranks widening culprits, coupling hotspots, and
//! fallback traps without requiring a Git diff.
use crate::graph::{DependencyGraph, GraphUncertainty, GraphUncertaintyScope};
use crate::manifest::{FileNarrowing, ImpactMode, TestingManifest};
use crate::protocol::{
    CouplingHotspot, DiagnoseResult, DiagnoseSummary, FallbackTrap, IssueScope,
    PROTOCOL_SCHEMA_VERSION, WideningCulprit,
};
use crate::scope::{deepest_project_for_path, path_is_inside};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::path::Path;
use std::process::Command;

struct ModNode {
    path: String,
    project: Option<usize>,
    is_test: bool,
    importers: Vec<usize>,
}

struct WorkspaceIndex<'a> {
    proj_by_id: HashMap<&'a str, usize>,
    reach_projs: BTreeSet<usize>,
    reach_tasks: Vec<usize>,
    closures: Vec<BTreeSet<usize>>,
    mods: Vec<ModNode>,
    tests_by_proj: Vec<usize>,
    total_tests: usize,
    uncertainties: Vec<GraphUncertainty>,
}

pub(crate) fn build_diagnose(
    manifest: &TestingManifest,
    workspace_root: &Path,
    graph: Option<&DependencyGraph>,
) -> DiagnoseResult {
    let idx = build_index(manifest, graph);
    let (leaf_skip, hotspots) = analyze_reachability(manifest, &idx);
    let (unowned, uncovered, traps) = find_fallback_traps(manifest, &idx, workspace_root, graph);
    let whole_ws = idx
        .uncertainties
        .iter()
        .filter(|u| u.scope == GraphUncertaintyScope::WholeWorkspace)
        .count();
    DiagnoseResult {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        summary: DiagnoseSummary {
            total_modules: idx.mods.len(),
            total_projects: manifest.projects.len(),
            total_tasks: manifest.tasks.len(),
            total_test_files: idx.total_tests,
            total_uncertainties: idx.uncertainties.len(),
            whole_workspace_uncertainties: whole_ws,
            unowned_tracked_files: unowned,
            non_code_uncovered_files: uncovered,
            estimated_leaf_skip_percent: leaf_skip,
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
        let is_test = is_test_module(&node.path, &narrowings);
        total_tests += usize::from(is_test);
        if is_test && let Some(p) = project {
            tests_by_proj[p] += 1;
        }
        let path = node.path.clone();
        mods.push(ModNode {
            path,
            project,
            is_test,
            importers: Vec::new(),
        });
    }
    for (imp_i, node) in nodes.iter().enumerate() {
        for imp in &node.imports {
            if let Some(&t_i) = imp.resolved_path.as_deref().and_then(|p| by_path.get(p))
                && mods[t_i].importers.last() != Some(&imp_i)
            {
                mods[t_i].importers.push(imp_i);
            }
        }
    }
    let uncertainties = graph.map_or_else(Vec::new, DependencyGraph::uncertainties);
    WorkspaceIndex {
        proj_by_id,
        reach_projs,
        reach_tasks,
        closures,
        mods,
        tests_by_proj,
        total_tests,
        uncertainties,
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

fn is_test_module(path: &str, narrowings: &[&FileNarrowing]) -> bool {
    if !narrowings.is_empty() {
        return narrowings.iter().any(|n| {
            n.suffixes.iter().any(|s| path.ends_with(s))
                && !n.exclude_suffixes.iter().any(|e| path.ends_with(e))
        });
    }
    const EXTS: &[&str] = &["ts", "tsx", "js", "jsx", "mts", "mjs", "cts", "cjs"];
    path.contains("/__tests__/")
        || path.rsplit_once('.').is_some_and(|(stem, ext)| {
            EXTS.contains(&ext) && (stem.ends_with(".test") || stem.ends_with(".spec"))
        })
}

fn rank_culprits(manifest: &TestingManifest, idx: &WorkspaceIndex<'_>) -> Vec<WideningCulprit> {
    let mut out = Vec::with_capacity(idx.uncertainties.len());
    for u in &idx.uncertainties {
        let owner = deepest_project_for_path(&manifest.projects, &u.path);
        let owner_i = owner.and_then(|p| idx.proj_by_id.get(p.id.as_str()).copied());
        let ws = u.scope == GraphUncertaintyScope::WholeWorkspace;
        let (wp, wt, wf) = match owner_i {
            Some(i) => {
                let s = if ws {
                    &idx.reach_projs
                } else {
                    &idx.closures[i]
                };
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

fn analyze_reachability(
    manifest: &TestingManifest,
    idx: &WorkspaceIndex<'_>,
) -> (f64, Vec<CouplingHotspot>) {
    let sources: Vec<usize> = (0..idx.mods.len())
        .filter(|&i| !idx.mods[i].is_test)
        .collect();
    let (mut seen_m, mut seen_p) = (
        vec![0u32; idx.mods.len()],
        vec![0u32; manifest.projects.len()],
    );
    let (mut queue, mut epoch) = (VecDeque::new(), 0u32);
    let mut run_bfs = |start: usize| -> (usize, usize, usize) {
        epoch += 1;
        queue.clear();
        seen_m[start] = epoch;
        queue.push_back(start);
        let (mut mods, mut projs, mut tests) = (0, 0, 0);
        while let Some(c) = queue.pop_front() {
            mods += 1;
            tests += usize::from(idx.mods[c].is_test);
            if let Some(p) = idx.mods[c].project
                && seen_p[p] != epoch
            {
                seen_p[p] = epoch;
                projs += 1;
            }
            for &imp in &idx.mods[c].importers {
                if seen_m[imp] != epoch {
                    seen_m[imp] = epoch;
                    queue.push_back(imp);
                }
            }
        }
        (mods, projs, tests)
    };
    let leaf_skip = if idx.total_tests == 0 || sources.is_empty() {
        0.0
    } else {
        let step_n = sources.len().min(64);
        let sum: f64 = (0..step_n)
            .map(|s| sources[(s * sources.len()) / step_n])
            .map(|i| idx.total_tests.saturating_sub(run_bfs(i).2) as f64 / idx.total_tests as f64)
            .sum();
        ((sum / step_n as f64) * 10_000.0).round() / 100.0
    };
    let candidates = if sources.len() <= 100 {
        sources
    } else {
        let mut by_in = sources.clone();
        by_in.sort_by(|&a, &b| {
            idx.mods[b]
                .importers
                .len()
                .cmp(&idx.mods[a].importers.len())
                .then_with(|| idx.mods[a].path.cmp(&idx.mods[b].path))
        });
        let mut set: BTreeSet<usize> = by_in.into_iter().take(60).collect();
        set.extend((0..40).map(|s| sources[(s * sources.len()) / 40]));
        set.into_iter().collect()
    };
    let mut hotspots = Vec::new();
    for i in candidates {
        let (rm, rp, rt) = run_bfs(i);
        if rt == 0 && rm <= 1 {
            continue;
        }
        let pct = if idx.total_tests == 0 {
            0.0
        } else {
            ((rt as f64 / idx.total_tests as f64) * 10_000.0).round() / 100.0
        };
        hotspots.push(CouplingHotspot {
            path: idx.mods[i].path.clone(),
            project: idx.mods[i].project.map(|p| manifest.projects[p].id.clone()),
            reached_modules: rm,
            reached_projects: rp,
            reached_test_files: rt,
            reached_test_percent: pct,
        });
    }
    hotspots.sort_by(|a, b| {
        b.reached_test_files
            .cmp(&a.reached_test_files)
            .then_with(|| b.reached_modules.cmp(&a.reached_modules))
            .then_with(|| b.reached_projects.cmp(&a.reached_projects))
            .then_with(|| a.path.cmp(&b.path))
    });
    hotspots.truncate(15);
    (leaf_skip, hotspots)
}

fn find_fallback_traps(
    manifest: &TestingManifest,
    idx: &WorkspaceIndex<'_>,
    root: &Path,
    graph: Option<&DependencyGraph>,
) -> (usize, usize, Vec<FallbackTrap>) {
    let (mut unowned, mut uncovered) = (0, 0);
    let mut groups: BTreeMap<(String, String), FallbackTrap> = BTreeMap::new();
    let non_code = &manifest.workspace.non_code_suffixes;
    for path in tracked_files(root) {
        let (kind, prefix, project) = match deepest_project_for_path(&manifest.projects, &path) {
            None => {
                unowned += 1;
                let mut s = path.split('/');
                let pref = match (s.next(), s.next()) {
                    (Some(a), Some(b)) if s.next().is_some() => format!("{a}/{b}/"),
                    (Some(a), Some(_)) => format!("{a}/"),
                    _ => "./".to_owned(),
                };
                ("unowned-directory", pref, None)
            }
            Some(p) => {
                let (Some(g), Some(&pi)) = (graph, idx.proj_by_id.get(p.id.as_str())) else {
                    continue;
                };
                let sql_ok = manifest.workspace.sql.as_ref().is_some_and(|s| {
                    s.migration_roots.iter().any(|r| path_is_inside(&path, r))
                        || s.snapshot_patterns
                            .iter()
                            .any(|sp| path.starts_with(&sp.prefix) && path.ends_with(&sp.suffix))
                });
                let skip = !idx.reach_projs.contains(&pi)
                    || g.contains_path(&path)
                    || sql_ok
                    || non_code.iter().any(|s| path.ends_with(s));
                if skip {
                    continue;
                }
                uncovered += 1;
                let ext = Path::new(&path).extension().and_then(|e| e.to_str());
                let label = ext
                    .filter(|e| !e.is_empty())
                    .map_or("(no extension)".into(), |e| format!("*.{e}"));
                (
                    "non-code-in-reachability-project",
                    format!("{label} in {}", p.id),
                    Some(p.id.clone()),
                )
            }
        };
        let e = groups
            .entry((kind.to_owned(), prefix.clone()))
            .or_insert_with(|| FallbackTrap {
                kind: kind.to_owned(),
                prefix,
                file_count: 0,
                sample_paths: Vec::new(),
                project,
            });
        e.file_count += 1;
        if e.sample_paths.len() < 3 {
            e.sample_paths.push(path);
        }
    }
    let mut traps: Vec<FallbackTrap> = groups.into_values().collect();
    traps.sort_by(|a, b| {
        b.file_count
            .cmp(&a.file_count)
            .then_with(|| (&a.kind, &a.prefix).cmp(&(&b.kind, &b.prefix)))
    });
    traps.truncate(30);
    (unowned, uncovered, traps)
}

fn tracked_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    if let Ok(out) = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(root)
        .output()
        && out.status.success()
    {
        for raw in out.stdout.split(|&b| b == 0).filter(|e| !e.is_empty()) {
            if let Ok(text) = std::str::from_utf8(raw) {
                files.push(text.replace('\\', "/"));
            }
        }
        files.sort();
    }
    files
}
