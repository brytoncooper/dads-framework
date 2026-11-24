//! Exact runtime and typecheck reachability analysis for `dad-test diagnose`.
use crate::diagnose::{UncertaintyTarget, WorkspaceIndex};
use crate::diagnose_remediation::hotspot_remediation;
use crate::manifest::TestingManifest;
use crate::protocol::CouplingHotspot;
use std::collections::{BTreeSet, VecDeque};

pub(crate) fn analyze_reachability(
    manifest: &TestingManifest,
    idx: &WorkspaceIndex<'_>,
) -> (f64, f64, Vec<CouplingHotspot>) {
    let runtime_tests = count_reaching_tests(idx, false);
    let typecheck_tests = count_reaching_tests(idx, true);
    let sources: Vec<usize> = (0..idx.mods.len())
        .filter(|&i| !idx.mods[i].is_test)
        .collect();
    let potential_skip = if idx.total_tests == 0 || sources.is_empty() {
        0.0
    } else {
        let sum: f64 = sources
            .iter()
            .map(|&i| {
                idx.total_tests.saturating_sub(runtime_tests[i]) as f64 / idx.total_tests as f64
            })
            .sum();
        round_percent(sum / sources.len() as f64)
    };
    let effective_skip = compute_effective_skip(idx, &sources, potential_skip);
    let hotspots = rank_hotspots(manifest, idx, &sources, &runtime_tests, &typecheck_tests);
    (effective_skip, potential_skip, hotspots)
}

/// Forward BFS from every test file along import edges gives exact `reached_test_files` for
/// every module in the workspace without missing deep transitive hubs.
fn count_reaching_tests(idx: &WorkspaceIndex<'_>, include_type_only: bool) -> Vec<usize> {
    let mut counts = vec![0usize; idx.mods.len()];
    let mut seen = vec![0u32; idx.mods.len()];
    let mut queue = VecDeque::new();
    let mut epoch = 0u32;
    for (t_i, node) in idx.mods.iter().enumerate() {
        if !node.is_test {
            continue;
        }
        epoch += 1;
        seen[t_i] = epoch;
        queue.push_back(t_i);
        while let Some(c) = queue.pop_front() {
            counts[c] += 1;
            let deps = if include_type_only {
                &idx.mods[c].all_deps
            } else {
                &idx.mods[c].runtime_deps
            };
            for &dep in deps {
                if seen[dep] != epoch {
                    seen[dep] = epoch;
                    queue.push_back(dep);
                }
            }
        }
    }
    counts
}

fn compute_effective_skip(idx: &WorkspaceIndex<'_>, sources: &[usize], potential_skip: f64) -> f64 {
    if idx.total_tests == 0 || sources.is_empty() || idx.has_unowned_whole_ws {
        return 0.0;
    }
    if idx.uncertainties.is_empty() {
        return potential_skip;
    }
    let whole_ws_tests: usize = idx
        .whole_ws_owned_widened
        .iter()
        .map(|&p| idx.tests_by_proj[p])
        .sum();
    if whole_ws_tests >= idx.total_tests {
        return 0.0;
    }
    let step_n = sources.len().min(64);
    let (mut seen, mut queue, mut epoch) = (vec![0u32; idx.mods.len()], VecDeque::new(), 0u32);
    let mut widened_projs = BTreeSet::new();
    let mut sum = 0.0;
    for s in 0..step_n {
        let start = sources[(s * sources.len()) / step_n];
        epoch += 1;
        queue.clear();
        widened_projs.clear();
        widened_projs.extend(idx.whole_ws_owned_widened.iter().copied());
        seen[start] = epoch;
        queue.push_back(start);
        let mut all_widened = false;
        let mut reached_tests = Vec::new();
        while let Some(c) = queue.pop_front() {
            if idx.mods[c].is_test {
                reached_tests.push(c);
            }
            for &target in &idx.mods[c].module_uncertainty_targets {
                match target {
                    UncertaintyTarget::LocalProject(p) => {
                        widened_projs.insert(p);
                    }
                    UncertaintyTarget::Closure(p) => {
                        widened_projs.extend(idx.closures[p].iter().copied());
                    }
                    UncertaintyTarget::FullFallback => all_widened = true,
                }
            }
            for &imp in &idx.mods[c].runtime_importers {
                if seen[imp] != epoch {
                    seen[imp] = epoch;
                    queue.push_back(imp);
                }
            }
        }
        let effective_tests = if all_widened {
            idx.total_tests
        } else {
            let widened_count: usize = widened_projs.iter().map(|&p| idx.tests_by_proj[p]).sum();
            let extra_direct = reached_tests
                .iter()
                .filter(|&&t| {
                    idx.mods[t]
                        .project
                        .is_none_or(|p| !widened_projs.contains(&p))
                })
                .count();
            (widened_count + extra_direct).min(idx.total_tests)
        };
        sum += idx.total_tests.saturating_sub(effective_tests) as f64 / idx.total_tests as f64;
    }
    round_percent(sum / step_n as f64)
}

fn rank_hotspots(
    manifest: &TestingManifest,
    idx: &WorkspaceIndex<'_>,
    sources: &[usize],
    runtime_tests: &[usize],
    typecheck_tests: &[usize],
) -> Vec<CouplingHotspot> {
    let mut ranked: Vec<usize> = sources
        .iter()
        .copied()
        .filter(|&i| runtime_tests[i] > 0 || typecheck_tests[i] > 0)
        .collect();
    ranked.sort_by(|&a, &b| {
        runtime_tests[b]
            .cmp(&runtime_tests[a])
            .then_with(|| typecheck_tests[b].cmp(&typecheck_tests[a]))
            .then_with(|| idx.mods[a].path.cmp(&idx.mods[b].path))
    });
    ranked.truncate(15);
    let (mut seen_m, mut seen_p) = (
        vec![0u32; idx.mods.len()],
        vec![0u32; manifest.projects.len()],
    );
    let (mut queue, mut epoch) = (VecDeque::new(), 0u32);
    ranked
        .into_iter()
        .map(|i| {
            let rt = runtime_tests[i];
            let tc = typecheck_tests[i];
            let use_all = rt == 0;
            epoch += 1;
            queue.clear();
            seen_m[i] = epoch;
            queue.push_back(i);
            let (mut rm, mut rp) = (0, 0);
            while let Some(c) = queue.pop_front() {
                rm += 1;
                if let Some(p) = idx.mods[c].project
                    && seen_p[p] != epoch
                {
                    seen_p[p] = epoch;
                    rp += 1;
                }
                let imps = if use_all {
                    &idx.mods[c].all_importers
                } else {
                    &idx.mods[c].runtime_importers
                };
                for &imp in imps {
                    if seen_m[imp] != epoch {
                        seen_m[imp] = epoch;
                        queue.push_back(imp);
                    }
                }
            }
            let pct = if idx.total_tests == 0 {
                0.0
            } else {
                round_percent(rt as f64 / idx.total_tests as f64)
            };
            CouplingHotspot {
                path: idx.mods[i].path.clone(),
                project: idx.mods[i].project.map(|p| manifest.projects[p].id.clone()),
                reached_modules: rm,
                reached_projects: rp,
                reached_test_files: rt,
                reached_test_percent: pct,
                typecheck_reached_test_files: tc,
                remediation: hotspot_remediation(rt, tc, rp),
            }
        })
        .collect()
}

fn round_percent(ratio: f64) -> f64 {
    (ratio * 10_000.0).round() / 100.0
}
