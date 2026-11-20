//! Behaviour tests for the whole crate: a plan or a run is asserted through the public protocol
//! against a real temporary git repository, never against an internal shape.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]
mod graph_analysis_need;
mod graph_widening;
mod planning;
mod running;
mod support;
