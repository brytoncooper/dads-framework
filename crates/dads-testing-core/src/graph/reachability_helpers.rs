//! Re-export propagation, queue bookkeeping, and uncertainty builders for graph reachability.
use super::compact::CImport;
use super::types::{GraphUncertainty, GraphUncertaintyScope, ReachedEdge, SourceLocation};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// The state one symbol-level walk carries: what it has reached, what it could not prove, the
/// edges it followed, which `(module, symbol)` pairs have already been queued, and which modules
/// have already propagated their own exports.
#[derive(Default)]
pub(super) struct SymbolWalk {
    pub(super) paths: BTreeSet<String>,
    pub(super) uncertainties: Vec<GraphUncertainty>,
    pub(super) edges: Vec<ReachedEdge>,
    pub(super) queue: VecDeque<(String, BTreeSet<String>)>,
    pub(super) seen_exports: BTreeMap<String, BTreeSet<String>>,
    pub(super) module_eval_queue: VecDeque<String>,
    pub(super) seen_module_eval: BTreeSet<String>,
    pub(super) own_exports_propagated: BTreeSet<String>,
    /// Tracks exact changed target members behind `export * as ns from "./target"` per `(barrel, ns)`.
    pub(super) ns_reexport_members: BTreeMap<(String, String), BTreeSet<String>>,
    /// Exports that changed directly (not exclusively via `export * as ns`), disabling member filtering.
    pub(super) non_ns_exports: BTreeSet<(String, String)>,
}

/// An `export *` re-export forwards every changed name but `default`, which it does not re-export.
pub(super) fn follow_reexport_all(
    walk: &mut SymbolWalk,
    e: &CImport,
    source: String,
    target: &str,
    exports: &BTreeSet<String>,
) {
    let reexported = exports
        .iter()
        .filter(|name| name.as_str() != "default")
        .cloned()
        .collect::<BTreeSet<_>>();
    if reexported.is_empty() {
        return;
    }
    walk.edges.push(ReachedEdge {
        importer: source.clone(),
        target: target.to_owned(),
        symbols: reexported.clone(),
        position: e.position,
    });
    walk.paths.insert(source.clone());
    enqueue_direct_exports(walk, source, reexported);
}

/// An `export * as ns from "./target"` namespace re-export binds EVERY runtime export of `target`
/// (including `"default"`) under exported name `ns`, recording the exact changed member names so
/// tracked downstream `ns.foo` reads stay symbol-precise (`NamespaceAndImports.lean` Theorems 1–3).
pub(super) fn follow_reexport_namespace(
    walk: &mut SymbolWalk,
    e: &CImport,
    source: String,
    target: &str,
    ns_name: &str,
    exports: &BTreeSet<String>,
) {
    if exports.is_empty() {
        return;
    }
    walk.edges.push(ReachedEdge {
        importer: source.clone(),
        target: target.to_owned(),
        symbols: exports.clone(),
        position: e.position,
    });
    walk.paths.insert(source.clone());
    let entry = walk
        .ns_reexport_members
        .entry((source.clone(), ns_name.to_owned()))
        .or_default();
    let mut grew = false;
    for sym in exports {
        grew |= entry.insert(sym.clone());
    }
    if grew {
        walk.seen_exports
            .entry(source.clone())
            .or_default()
            .insert(ns_name.to_owned());
        walk.queue
            .push_back((source, BTreeSet::from([ns_name.to_owned()])));
    }
}

pub(super) fn enqueue_direct_exports(
    walk: &mut SymbolWalk,
    module: String,
    exports: BTreeSet<String>,
) {
    for sym in &exports {
        walk.non_ns_exports.insert((module.clone(), sym.clone()));
    }
    enqueue_exports(walk, module, exports);
}

/// Enqueues only `(module, symbol)` pairs not yet seen so diamond `export *` barrels and mixed
/// own-export + `export *` modules propagate every changed symbol without looping.
pub(super) fn enqueue_exports(walk: &mut SymbolWalk, module: String, exports: BTreeSet<String>) {
    let seen = walk.seen_exports.entry(module.clone()).or_default();
    let fresh = exports
        .into_iter()
        .filter(|symbol| seen.insert(symbol.clone()))
        .collect::<BTreeSet<_>>();
    if !fresh.is_empty() {
        walk.queue.push_back((module, fresh));
    }
}

pub(super) fn ambiguous_import(path: String, import: &CImport) -> GraphUncertainty {
    GraphUncertainty {
        path,
        code: "ambiguous-cross-file-import".into(),
        message: "Importer cannot be matched to a named runtime export.".into(),
        scope: GraphUncertaintyScope::ReachedModule,
        location: import_location(import),
    }
}

/// A core-generated import uncertainty is located only when its frontend recorded a position.
fn import_location(import: &CImport) -> Option<SourceLocation> {
    import.position.map(|position| SourceLocation {
        span: import.span.clone(),
        position,
    })
}

pub(super) fn uncertainty_span_start(uncertainty: &GraphUncertainty) -> Option<u32> {
    uncertainty
        .location
        .as_ref()
        .map(|location| location.span.start)
}
