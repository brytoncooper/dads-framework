//! Deterministic Simulation Testing (DST) harness for `dad-test`.
//!
//! Generates seeded multi-project TypeScript workspaces with realistic monorepo topologies,
//! executes 58 adversarial mutation and execution families across working-tree, commit-to-commit,
//! `--plan-file`, sharded, and shared-cache timelines, and compares `dad-test` against a real
//! Node 24 V8 oracle.

pub mod dad_client;
pub mod generator;
pub mod generator_advanced;
pub mod generator_manifest;
pub mod invariants;
pub mod model;
pub mod mutations;
pub mod mutations_advanced;
pub mod node_oracle;
pub mod rng;
pub mod runner;
pub mod timelines;

pub use model::{DstSummary, MutationKind, SoundnessFailure};
pub use runner::{DstConfig, run_dst_sweep};
