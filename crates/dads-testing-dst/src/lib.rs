//! Deterministic Simulation Testing (DST) harness for `dad-test`.
//!
//! Generates seeded multi-project TypeScript workspaces with realistic monorepo topologies,
//! executes mutations across working-tree, commit-to-commit, `--plan-file`, and shared-cache
//! timelines, and compares `dad-test` selections and cached runs against a real Node 24 V8 oracle.

pub mod dad_client;
pub mod generator;
pub mod generator_manifest;
pub mod invariants;
pub mod model;
pub mod mutations;
pub mod node_oracle;
pub mod rng;
pub mod runner;

pub use model::{DstSummary, MutationKind, SoundnessFailure};
pub use runner::{DstConfig, run_dst_sweep};
