//! Seeded random workspace & dependency graph generator for generative chaos DST (`Section E`).

pub use crate::fuzz_graph_types::{
    ChaosBarrelStyle, ChaosFixtureSpec, ChaosImportEdge, ChaosLeafData, ChaosModuleKind,
    ChaosModuleSpec, ChaosProjectSpec, ChaosWorkspaceSpec, ExportShape,
};
use crate::model::FallbackMode;
use crate::rng::SeededRng;
use std::collections::{BTreeMap, BTreeSet};

pub fn generate_chaos_workspace(seed: u64) -> ChaosWorkspaceSpec {
    let mut rng = SeededRng::new(seed ^ 0x51A0_5EED_C0DE_1234);
    let project_count = 3 + rng.range_usize(10); // [3, 12]
    let module_count = (15 + rng.range_usize(36)).max(project_count + 3); // [15, 50]
    let fixture_count = 2 + rng.range_usize(4); // [2, 5]
    let use_file_narrowing = rng.chance(3, 4);
    let use_tsconfig_aliases = rng.chance(2, 3);

    let fixtures: Vec<ChaosFixtureSpec> = (0..fixture_count)
        .map(|i| ChaosFixtureSpec {
            rel_path: format!("fixtures/fx{i}.json"),
            value: 10 + i32::try_from(rng.range_usize(40)).unwrap_or(1),
        })
        .collect();

    let mut projects = build_projects(project_count, &mut rng);
    let mut modules = build_modules(
        &projects,
        module_count,
        fixture_count,
        use_tsconfig_aliases,
        &mut rng,
    );
    inject_controlled_cycles(&mut modules, use_tsconfig_aliases, &mut rng);
    populate_project_extras_and_fallbacks(&mut projects, &modules, &mut rng);

    ChaosWorkspaceSpec {
        seed,
        projects,
        modules,
        fixtures,
        use_file_narrowing,
        use_tsconfig_aliases,
        pure_factories: vec!["mkPure".to_owned(), "z.*".to_owned()],
    }
}

fn build_projects(count: usize, rng: &mut SeededRng) -> Vec<ChaosProjectSpec> {
    let mut projects = Vec::with_capacity(count);
    for i in 0..count {
        let id = format!("p{i}");
        let root = if i > 0 && rng.chance(1, 5) {
            format!("apps/[id]/p{i}")
        } else if i > 0 && rng.chance(1, 6) {
            format!("routes/(group)/p{i}")
        } else {
            format!("p{i}")
        };
        let roll = rng.range_usize(100);
        let fallback_mode = if roll < 55 {
            FallbackMode::Empty
        } else if roll < 85 {
            FallbackMode::Partial
        } else {
            FallbackMode::Complete
        };
        projects.push(ChaosProjectSpec {
            id,
            root,
            fallback_mode,
            fallback_deps: Vec::new(),
            env_tag: (10 + (i * 7) + rng.range_usize(5)).to_string(),
            has_typecheck: i < 2 || rng.chance(3, 5),
            extra_test_imports: Vec::new(),
        });
    }
    projects
}

fn build_modules(
    projects: &[ChaosProjectSpec],
    module_count: usize,
    fixture_count: usize,
    use_aliases: bool,
    rng: &mut SeededRng,
) -> Vec<ChaosModuleSpec> {
    let mut modules: Vec<ChaosModuleSpec> = Vec::with_capacity(module_count);
    for id in 0..module_count {
        let project_idx = if id < projects.len() {
            id
        } else {
            rng.range_usize(projects.len())
        };
        let rel_path = format!("{}/m{id}.ts", projects[project_idx].root);
        let can_be_barrel = id >= projects.len()
            && modules.iter().any(|m| m.barrel_depth < 3)
            && rng.chance(35, 100);
        let module = if can_be_barrel {
            make_barrel_module(id, project_idx, rel_path, &modules, use_aliases, rng)
        } else {
            make_leaf_module(
                id,
                project_idx,
                rel_path,
                &modules,
                fixture_count,
                use_aliases,
                rng,
            )
        };
        modules.push(module);
    }
    modules
}

fn make_barrel_module(
    id: usize,
    project_idx: usize,
    rel_path: String,
    existing: &[ChaosModuleSpec],
    use_aliases: bool,
    rng: &mut SeededRng,
) -> ChaosModuleSpec {
    let eligible: Vec<usize> = existing
        .iter()
        .filter(|m| m.barrel_depth < 3)
        .map(|m| m.id)
        .collect();
    let target_mod = *rng.choose(&eligible).unwrap_or(&0);
    let target = &existing[target_mod];
    let (style, export_shape) = pick_barrel_style(target.export_shape, rng);
    let use_alias = use_aliases && target.project_idx != project_idx && rng.chance(1, 2);
    ChaosModuleSpec {
        id,
        project_idx,
        rel_path,
        kind: ChaosModuleKind::Barrel {
            style,
            target_mod,
            use_alias,
        },
        export_shape,
        barrel_depth: target.barrel_depth + 1,
    }
}

fn pick_barrel_style(
    target_shape: ExportShape,
    rng: &mut SeededRng,
) -> (ChaosBarrelStyle, ExportShape) {
    match target_shape {
        ExportShape::Standard => match rng.range_usize(5) {
            0 => (ChaosBarrelStyle::Named, ExportShape::Standard),
            1 => (ChaosBarrelStyle::Aliased, ExportShape::Aliased),
            2 => (ChaosBarrelStyle::DefaultWrap, ExportShape::DefaultOnly),
            3 => (ChaosBarrelStyle::ExportStar, ExportShape::Standard),
            _ => (ChaosBarrelStyle::ExportStarAsNs, ExportShape::Namespace),
        },
        ExportShape::Aliased => {
            if rng.chance(1, 2) {
                (ChaosBarrelStyle::Named, ExportShape::Standard)
            } else {
                (ChaosBarrelStyle::ExportStar, ExportShape::Aliased)
            }
        }
        ExportShape::DefaultOnly => {
            if rng.chance(1, 2) {
                (ChaosBarrelStyle::Named, ExportShape::Standard)
            } else {
                (ChaosBarrelStyle::DefaultWrap, ExportShape::DefaultOnly)
            }
        }
        ExportShape::Namespace => {
            if rng.chance(1, 2) {
                (ChaosBarrelStyle::Named, ExportShape::Namespace)
            } else {
                (ChaosBarrelStyle::ExportStar, ExportShape::Namespace)
            }
        }
    }
}

fn make_leaf_module(
    id: usize,
    project_idx: usize,
    rel_path: String,
    existing: &[ChaosModuleSpec],
    fixture_count: usize,
    use_aliases: bool,
    rng: &mut SeededRng,
) -> ChaosModuleSpec {
    let mut imports = Vec::new();
    let mut chosen = BTreeSet::new();
    if !existing.is_empty() {
        for _ in 0..rng.range_usize(3) {
            let target_id = rng.range_usize(existing.len());
            if chosen.insert(target_id) {
                let target_proj = existing[target_id].project_idx;
                imports.push(ChaosImportEdge {
                    target_mod: target_id,
                    use_alias: use_aliases && target_proj != project_idx && rng.chance(1, 2),
                    type_only: rng.chance(1, 4),
                });
            }
        }
    }
    let mut side_effect_imports = Vec::new();
    let leaf_candidates: Vec<usize> = existing
        .iter()
        .filter(|m| matches!(m.kind, ChaosModuleKind::Leaf(_)) && !chosen.contains(&m.id))
        .map(|m| m.id)
        .collect();
    if !leaf_candidates.is_empty()
        && rng.chance(1, 6)
        && let Some(&se_target) = rng.choose(&leaf_candidates)
    {
        side_effect_imports.push(se_target);
    }
    let fixture_idx =
        (fixture_count > 0 && rng.chance(1, 5)).then(|| rng.range_usize(fixture_count));
    ChaosModuleSpec {
        id,
        project_idx,
        rel_path,
        kind: ChaosModuleKind::Leaf(ChaosLeafData {
            pure_val: 2 + i32::try_from(rng.range_usize(40)).unwrap_or(1),
            unused_pure_val: 100 + i32::try_from(rng.range_usize(90)).unwrap_or(1),
            helper_val: 1 + i32::try_from(rng.range_usize(20)).unwrap_or(1),
            impure_val: 1 + i32::try_from(rng.range_usize(15)).unwrap_or(1),
            has_impure_init: rng.chance(1, 4),
            has_pure_annotation: rng.chance(1, 3),
            has_pure_factory: rng.chance(1, 3),
            fixture_idx,
            imports,
            side_effect_imports,
        }),
        export_shape: ExportShape::Standard,
        barrel_depth: 0,
    }
}

fn inject_controlled_cycles(
    modules: &mut [ChaosModuleSpec],
    use_aliases: bool,
    rng: &mut SeededRng,
) {
    let leaves: Vec<usize> = modules
        .iter()
        .filter(|m| matches!(m.kind, ChaosModuleKind::Leaf(_)))
        .map(|m| m.id)
        .collect();
    if leaves.len() < 4 {
        return;
    }
    let mut used = BTreeSet::new();
    for _ in 0..(1 + rng.range_usize(2)) {
        let idx_a = rng.range_usize(leaves.len() - 1);
        let (a, b) = (leaves[idx_a], leaves[idx_a + 1]);
        if !used.insert(a) || !used.insert(b) {
            continue;
        }
        let cross_proj = modules[a].project_idx != modules[b].project_idx;
        let alias = use_aliases && cross_proj && rng.chance(1, 2);
        add_runtime_edge(&mut modules[a], b, alias);
        add_runtime_edge(&mut modules[b], a, alias);
    }
}

fn add_runtime_edge(module: &mut ChaosModuleSpec, target_mod: usize, use_alias: bool) {
    if let ChaosModuleKind::Leaf(leaf) = &mut module.kind {
        if let Some(edge) = leaf.imports.iter_mut().find(|e| e.target_mod == target_mod) {
            edge.type_only = false;
        } else {
            leaf.imports.push(ChaosImportEdge {
                target_mod,
                use_alias,
                type_only: false,
            });
        }
    }
}

fn populate_project_extras_and_fallbacks(
    projects: &mut [ChaosProjectSpec],
    modules: &[ChaosModuleSpec],
    rng: &mut SeededRng,
) {
    let mut by_project: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for m in modules {
        by_project.entry(m.project_idx).or_default().push(m.id);
    }
    for (p_idx, proj) in projects.iter_mut().enumerate() {
        let mut cross = Vec::new();
        for other in modules {
            if other.project_idx < p_idx && rng.chance(1, 4) && cross.len() < 2 {
                cross.push(other.id);
            }
        }
        proj.extra_test_imports = cross;
    }

    let mut real_deps: Vec<BTreeSet<String>> = vec![BTreeSet::new(); projects.len()];
    for m in modules {
        for target_id in module_targets(m) {
            let target_proj = modules[target_id].project_idx;
            if target_proj != m.project_idx {
                real_deps[m.project_idx].insert(projects[target_proj].id.clone());
            }
        }
    }
    for (p_idx, proj) in projects.iter().enumerate() {
        for &target_id in &proj.extra_test_imports {
            let target_proj = modules[target_id].project_idx;
            if target_proj != p_idx {
                real_deps[p_idx].insert(projects[target_proj].id.clone());
            }
        }
    }
    for (p_idx, proj) in projects.iter_mut().enumerate() {
        let deps: Vec<String> = real_deps[p_idx].iter().cloned().collect();
        let half = deps.len().div_ceil(2);
        proj.fallback_deps = match proj.fallback_mode {
            FallbackMode::Empty => Vec::new(),
            FallbackMode::Partial => deps.into_iter().take(half).collect(),
            FallbackMode::Complete => deps,
        };
    }
}

pub fn module_targets(module: &ChaosModuleSpec) -> Vec<usize> {
    match &module.kind {
        ChaosModuleKind::Leaf(leaf) => leaf
            .imports
            .iter()
            .map(|e| e.target_mod)
            .chain(leaf.side_effect_imports.iter().copied())
            .collect(),
        ChaosModuleKind::Barrel { target_mod, .. } => vec![*target_mod],
    }
}

pub fn relative_import_path(from_file: &str, to_file: &str) -> String {
    let from_dir: Vec<&str> = match from_file.rsplit_once('/') {
        Some((dir, _)) => dir.split('/').collect(),
        None => Vec::new(),
    };
    let to_parts: Vec<&str> = to_file.split('/').collect();
    let mut common = 0usize;
    while common < from_dir.len()
        && common + 1 < to_parts.len()
        && from_dir[common] == to_parts[common]
    {
        common += 1;
    }
    let up = from_dir.len() - common;
    let mut segments = vec![".."; up];
    segments.extend_from_slice(&to_parts[common..]);
    let joined = segments.join("/");
    if joined.starts_with("../") || joined.starts_with("./") {
        joined
    } else {
        format!("./{joined}")
    }
}
