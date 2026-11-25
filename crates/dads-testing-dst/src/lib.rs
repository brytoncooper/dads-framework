//! Deterministic Simulation Testing (DST) harness for `dad-test`.
//!
//! Generates seeded multi-project TypeScript workspaces with realistic monorepo topologies,
//! executes 95 adversarial mutation and execution families across working-tree, commit-to-commit,
//! `--plan-file`, sharded, remote-cache, concurrent-writer, read-guard, and shared-cache
//! timelines, plus a generative random-graph chaos fuzzer with automatic delta shrinking, and
//! compares `dad-test` against real Node 24 V8 and TypeScript Compiler API (`tsc`) oracles.

pub mod dad_client;
pub mod fuzz_apply;
pub mod fuzz_apply_files;
pub mod fuzz_chaos;
pub mod fuzz_graph;
pub mod fuzz_graph_types;
pub mod fuzz_materialize;
pub mod fuzz_ops;
pub mod fuzz_parity;
pub mod fuzz_render;
pub mod fuzz_report;
pub mod fuzz_shrink;
pub mod fuzz_shrink_prune;
pub mod fuzz_verify;
pub mod generator;
pub mod generator_advanced;
pub mod generator_lang_edge;
pub mod generator_lifecycle;
pub mod generator_manifest;
pub mod generator_manifest_tasks;
pub mod generator_section_a;
pub mod generator_subsystems;
pub mod http_cache_mock;
pub mod invariants;
pub mod invariants_report;
pub mod model;
pub mod model_catalog;
pub mod mutations;
pub mod mutations_advanced;
pub mod mutations_lang_edge;
pub mod mutations_lifecycle;
pub mod mutations_section_a;
pub mod mutations_subsystems;
pub mod node_oracle;
pub mod node_oracle_js;
pub mod node_runner_js;
pub mod rng;
pub mod runner;
pub mod runner_step;
pub mod template_cache;
pub mod timelines;
pub mod timelines_cli;
pub mod timelines_concurrency;
pub mod timelines_read_guard;
pub mod timelines_remote_cache;
pub mod timelines_subsystems;
pub mod tsc_oracle;

pub use fuzz_chaos::{ChaosConfig, ChaosSummary, print_chaos_summary, run_chaos_sweep};
pub use fuzz_verify::ChaosFailure;
pub use model::{DstSummary, MutationKind, SoundnessFailure};
pub use runner::{DstConfig, run_dst_sweep};
