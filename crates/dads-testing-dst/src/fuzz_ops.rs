//! Compound multi-file PR mutation vocabulary (`ChaosOp`), live state, and seeded step generator.

use crate::fuzz_graph::{ChaosModuleKind, ChaosWorkspaceSpec};
use crate::node_oracle::OracleTestSpec;
use crate::rng::SeededRng;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum ChaosOp {
    EditPureExport {
        mod_id: usize,
        delta: i32,
    },
    EditImpureInitializer {
        mod_id: usize,
        delta: i32,
    },
    EditPrivateHelper {
        mod_id: usize,
        delta: i32,
    },
    AdjacentCommentAndRuntimeEdit {
        mod_id: usize,
        delta: i32,
    },
    CommentOrTypeOnlyEdit {
        mod_id: usize,
        seq: u32,
        break_type: bool,
    },
    ToggleSideEffectImport {
        mod_id: usize,
        target_mod: usize,
        add: bool,
    },
    EditJsonFixture {
        fixture_idx: usize,
        delta: i32,
    },
    AddNewModuleAndImport {
        project_idx: usize,
        consumer_mod: usize,
        name: String,
        value: i32,
    },
    AddFailingTestFile {
        project_idx: usize,
        name: String,
    },
    DeleteUnusedOrUsedFile {
        mod_id: usize,
    },
    StageAndEditWorkingTree {
        mod_id: usize,
        staged_delta: i32,
        working_delta: i32,
    },
    GitCommit {
        message: String,
    },
    CorruptRandomCacheBlob {
        pick: usize,
    },
    EditManifestEnv {
        project_idx: usize,
        val: i32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaosStep {
    pub ops: Vec<ChaosOp>,
}

#[derive(Debug, Default)]
pub struct ChaosLiveState {
    pub extra_task_tests: Vec<(String, OracleTestSpec)>,
    pub project_env_overrides: BTreeMap<String, String>,
    pub runtime_dirty: bool,
}

struct SampleState<'a> {
    spec: &'a ChaosWorkspaceSpec,
    leaf_ids: &'a [usize],
    rng: SeededRng,
    seq: u32,
    deleted_any: bool,
}

pub fn generate_chaos_steps(
    spec: &ChaosWorkspaceSpec,
    seed: u64,
    num_steps: usize,
) -> Vec<ChaosStep> {
    let leaf_ids: Vec<usize> = spec
        .modules
        .iter()
        .filter(|m| matches!(m.kind, ChaosModuleKind::Leaf(_)))
        .map(|m| m.id)
        .collect();
    let mut st = SampleState {
        spec,
        leaf_ids: &leaf_ids,
        rng: SeededRng::new(seed ^ 0xA5A5_F00D_9999_1111),
        seq: 1,
        deleted_any: false,
    };
    let mut steps = Vec::with_capacity(num_steps);
    for step_idx in 0..num_steps {
        if step_idx == 0 && st.rng.chance(1, 3) && !spec.modules.is_empty() {
            let mod_id = st.rng.range_usize(spec.modules.len());
            let seq = st.seq;
            st.seq += 1;
            steps.push(ChaosStep {
                ops: vec![ChaosOp::CommentOrTypeOnlyEdit {
                    mod_id,
                    seq,
                    break_type: false,
                }],
            });
            continue;
        }
        let op_count = 2 + st.rng.range_usize(4); // K in [2, 5]
        let mut ops = Vec::with_capacity(op_count);
        let mut step_committed = false;
        for op_idx in 0..op_count {
            ops.push(sample_op(&mut st, step_idx, op_idx, &mut step_committed));
        }
        steps.push(ChaosStep { ops });
    }
    steps
}

fn sample_op(
    st: &mut SampleState<'_>,
    step_idx: usize,
    op_idx: usize,
    step_committed: &mut bool,
) -> ChaosOp {
    let leaf = *st.rng.choose(st.leaf_ids).unwrap_or(&0);
    let delta = 1 + i32::try_from(st.rng.range_usize(9)).unwrap_or(1);
    st.seq += 1;
    let seq = st.seq;
    match st.rng.range_usize(14) {
        0 => ChaosOp::EditPureExport {
            mod_id: leaf,
            delta,
        },
        1 => ChaosOp::EditImpureInitializer {
            mod_id: leaf,
            delta,
        },
        2 => ChaosOp::EditPrivateHelper {
            mod_id: leaf,
            delta,
        },
        3 => ChaosOp::AdjacentCommentAndRuntimeEdit {
            mod_id: leaf,
            delta,
        },
        4 => ChaosOp::CommentOrTypeOnlyEdit {
            mod_id: leaf,
            seq,
            break_type: st.rng.chance(1, 2),
        },
        5 => {
            let target = *st.rng.choose(st.leaf_ids).unwrap_or(&0);
            ChaosOp::ToggleSideEffectImport {
                mod_id: leaf,
                target_mod: if target == leaf {
                    *st.leaf_ids.first().unwrap_or(&0)
                } else {
                    target
                },
                add: st.rng.chance(2, 3),
            }
        }
        6 if !st.spec.fixtures.is_empty() => ChaosOp::EditJsonFixture {
            fixture_idx: st.rng.range_usize(st.spec.fixtures.len()),
            delta,
        },
        7 => ChaosOp::AddNewModuleAndImport {
            project_idx: st.rng.range_usize(st.spec.projects.len()),
            consumer_mod: leaf,
            name: format!("dyn_{step_idx}_{op_idx}"),
            value: 5 + delta,
        },
        8 => ChaosOp::AddFailingTestFile {
            project_idx: st.rng.range_usize(st.spec.projects.len()),
            name: format!("z-fail-{step_idx}-{op_idx}"),
        },
        9 if !st.deleted_any && st.leaf_ids.len() > 2 => {
            st.deleted_any = true;
            ChaosOp::DeleteUnusedOrUsedFile { mod_id: leaf }
        }
        10 => ChaosOp::StageAndEditWorkingTree {
            mod_id: leaf,
            staged_delta: delta,
            working_delta: if st.rng.chance(1, 3) {
                -delta
            } else {
                delta + 2
            },
        },
        11 if !*step_committed => {
            *step_committed = true;
            ChaosOp::GitCommit {
                message: format!("chaos commit s{step_idx}"),
            }
        }
        12 => ChaosOp::CorruptRandomCacheBlob {
            pick: st.rng.range_usize(64),
        },
        _ => ChaosOp::EditManifestEnv {
            project_idx: st.rng.range_usize(st.spec.projects.len()),
            val: 100 + i32::try_from(seq).unwrap_or(1),
        },
    }
}
