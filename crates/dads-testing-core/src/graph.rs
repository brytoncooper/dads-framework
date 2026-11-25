//! Compact language-neutral dependency graph. Public frontend facts are packed into one sorted
//! intern table plus u32 module/import IDs and packed reverse adjacency.
mod compact;
mod pack;
mod reachability;
mod reachability_helpers;
mod types;

pub use compact::DependencyGraph;
pub use types::{
    ChangedModuleEvidence, GraphUncertainty, GraphUncertaintyScope, ImportFact, ImportKind,
    LineColumn, ModuleNode, Reachability, ReachedEdge, SourceLocation, SourceSpan, SymbolFact,
};

#[cfg(test)]
mod tests;
