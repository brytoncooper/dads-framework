//! Workspace project/module pruning and index remapping for Stage 4 of chaos delta-debugging.

use crate::fuzz_graph::{ChaosModuleKind, ChaosWorkspaceSpec, module_targets};
use crate::fuzz_ops::{ChaosOp, ChaosStep};
use std::collections::{BTreeMap, BTreeSet};

pub fn try_prune_project(
    spec: &ChaosWorkspaceSpec,
    steps: &[ChaosStep],
    drop_proj: usize,
) -> Option<(ChaosWorkspaceSpec, Vec<ChaosStep>)> {
    let drop_mods: BTreeSet<usize> = spec
        .modules
        .iter()
        .filter(|m| m.project_idx == drop_proj)
        .map(|m| m.id)
        .collect();
    if is_project_referenced(spec, steps, drop_proj, &drop_mods) {
        return None;
    }
    let proj_remap = build_index_remap(spec.projects.len(), |i| i != drop_proj);
    let mod_remap = build_index_remap(spec.modules.len(), |id| !drop_mods.contains(&id));
    let drop_proj_id = &spec.projects[drop_proj].id;

    let mut new_projects = Vec::with_capacity(spec.projects.len() - 1);
    for (idx, proj) in spec.projects.iter().enumerate() {
        if idx == drop_proj {
            continue;
        }
        let mut cloned = proj.clone();
        cloned.fallback_deps.retain(|dep| dep != drop_proj_id);
        cloned.extra_test_imports = cloned
            .extra_test_imports
            .iter()
            .filter_map(|old| mod_remap.get(old).copied())
            .collect();
        new_projects.push(cloned);
    }

    let mut new_modules = Vec::with_capacity(spec.modules.len() - drop_mods.len());
    for module in &spec.modules {
        let Some(&new_id) = mod_remap.get(&module.id) else {
            continue;
        };
        let new_proj = *proj_remap.get(&module.project_idx)?;
        let mut cloned = module.clone();
        cloned.id = new_id;
        cloned.project_idx = new_proj;
        cloned.rel_path = format!("{}/m{new_id}.ts", new_projects[new_proj].root);
        match &mut cloned.kind {
            ChaosModuleKind::Leaf(leaf) => {
                for edge in &mut leaf.imports {
                    edge.target_mod = *mod_remap.get(&edge.target_mod)?;
                }
                leaf.side_effect_imports = leaf
                    .side_effect_imports
                    .iter()
                    .filter_map(|t| mod_remap.get(t).copied())
                    .collect();
            }
            ChaosModuleKind::Barrel { target_mod, .. } => {
                *target_mod = *mod_remap.get(target_mod)?;
            }
        }
        new_modules.push(cloned);
    }

    let mut remapped_steps = Vec::with_capacity(steps.len());
    for step in steps {
        let mut ops = Vec::with_capacity(step.ops.len());
        for op in &step.ops {
            ops.push(remap_op(op, &proj_remap, &mod_remap)?);
        }
        remapped_steps.push(ChaosStep { ops });
    }

    let mut pruned = spec.clone();
    pruned.projects = new_projects;
    pruned.modules = new_modules;
    Some((pruned, remapped_steps))
}

fn is_project_referenced(
    spec: &ChaosWorkspaceSpec,
    steps: &[ChaosStep],
    drop_proj: usize,
    drop_mods: &BTreeSet<usize>,
) -> bool {
    for step in steps {
        if step
            .ops
            .iter()
            .any(|op| op_references(op, drop_proj, drop_mods))
        {
            return true;
        }
    }
    for (p_idx, proj) in spec.projects.iter().enumerate() {
        if p_idx != drop_proj
            && proj
                .extra_test_imports
                .iter()
                .any(|m| drop_mods.contains(m))
        {
            return true;
        }
    }
    spec.modules.iter().any(|m| {
        m.project_idx != drop_proj && module_targets(m).iter().any(|t| drop_mods.contains(t))
    })
}

fn op_references(op: &ChaosOp, proj: usize, mods: &BTreeSet<usize>) -> bool {
    match op {
        ChaosOp::EditPureExport { mod_id, .. }
        | ChaosOp::EditImpureInitializer { mod_id, .. }
        | ChaosOp::EditPrivateHelper { mod_id, .. }
        | ChaosOp::AdjacentCommentAndRuntimeEdit { mod_id, .. }
        | ChaosOp::CommentOrTypeOnlyEdit { mod_id, .. }
        | ChaosOp::DeleteUnusedOrUsedFile { mod_id }
        | ChaosOp::StageAndEditWorkingTree { mod_id, .. } => mods.contains(mod_id),
        ChaosOp::ToggleSideEffectImport {
            mod_id, target_mod, ..
        } => mods.contains(mod_id) || mods.contains(target_mod),
        ChaosOp::AddNewModuleAndImport {
            project_idx,
            consumer_mod,
            ..
        } => *project_idx == proj || mods.contains(consumer_mod),
        ChaosOp::AddFailingTestFile { project_idx, .. }
        | ChaosOp::EditManifestEnv { project_idx, .. } => *project_idx == proj,
        ChaosOp::EditJsonFixture { .. }
        | ChaosOp::GitCommit { .. }
        | ChaosOp::CorruptRandomCacheBlob { .. } => false,
    }
}

fn remap_op(
    op: &ChaosOp,
    proj_remap: &BTreeMap<usize, usize>,
    mod_remap: &BTreeMap<usize, usize>,
) -> Option<ChaosOp> {
    let mapped = match op {
        ChaosOp::EditPureExport { mod_id, delta } => ChaosOp::EditPureExport {
            mod_id: *mod_remap.get(mod_id)?,
            delta: *delta,
        },
        ChaosOp::EditImpureInitializer { mod_id, delta } => ChaosOp::EditImpureInitializer {
            mod_id: *mod_remap.get(mod_id)?,
            delta: *delta,
        },
        ChaosOp::EditPrivateHelper { mod_id, delta } => ChaosOp::EditPrivateHelper {
            mod_id: *mod_remap.get(mod_id)?,
            delta: *delta,
        },
        ChaosOp::AdjacentCommentAndRuntimeEdit { mod_id, delta } => {
            ChaosOp::AdjacentCommentAndRuntimeEdit {
                mod_id: *mod_remap.get(mod_id)?,
                delta: *delta,
            }
        }
        ChaosOp::CommentOrTypeOnlyEdit {
            mod_id,
            seq,
            break_type,
        } => ChaosOp::CommentOrTypeOnlyEdit {
            mod_id: *mod_remap.get(mod_id)?,
            seq: *seq,
            break_type: *break_type,
        },
        ChaosOp::ToggleSideEffectImport {
            mod_id,
            target_mod,
            add,
        } => ChaosOp::ToggleSideEffectImport {
            mod_id: *mod_remap.get(mod_id)?,
            target_mod: *mod_remap.get(target_mod)?,
            add: *add,
        },
        ChaosOp::AddNewModuleAndImport {
            project_idx,
            consumer_mod,
            name,
            value,
        } => ChaosOp::AddNewModuleAndImport {
            project_idx: *proj_remap.get(project_idx)?,
            consumer_mod: *mod_remap.get(consumer_mod)?,
            name: name.clone(),
            value: *value,
        },
        ChaosOp::AddFailingTestFile { project_idx, name } => ChaosOp::AddFailingTestFile {
            project_idx: *proj_remap.get(project_idx)?,
            name: name.clone(),
        },
        ChaosOp::DeleteUnusedOrUsedFile { mod_id } => ChaosOp::DeleteUnusedOrUsedFile {
            mod_id: *mod_remap.get(mod_id)?,
        },
        ChaosOp::StageAndEditWorkingTree {
            mod_id,
            staged_delta,
            working_delta,
        } => ChaosOp::StageAndEditWorkingTree {
            mod_id: *mod_remap.get(mod_id)?,
            staged_delta: *staged_delta,
            working_delta: *working_delta,
        },
        ChaosOp::EditManifestEnv { project_idx, val } => ChaosOp::EditManifestEnv {
            project_idx: *proj_remap.get(project_idx)?,
            val: *val,
        },
        ChaosOp::EditJsonFixture { .. }
        | ChaosOp::GitCommit { .. }
        | ChaosOp::CorruptRandomCacheBlob { .. } => op.clone(),
    };
    Some(mapped)
}

fn build_index_remap(len: usize, keep: impl Fn(usize) -> bool) -> BTreeMap<usize, usize> {
    let mut map = BTreeMap::new();
    let mut next = 0usize;
    for old in 0..len {
        if keep(old) {
            map.insert(old, next);
            next += 1;
        }
    }
    map
}
