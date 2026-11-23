//! Reverse traversal: which modules a change reaches, and where the answer stops being provable.
use super::compact::{CImport, DependencyGraph};
use super::types::{
    GraphUncertainty, GraphUncertaintyScope, ImportKind, Reachability, ReachedEdge, SourceLocation,
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// The state one symbol-level walk carries: what it has reached, what it could not prove, the
/// edges it followed, which `(module, symbol)` pairs have already been queued, and which modules
/// have already propagated their own exports.
#[derive(Default)]
struct SymbolWalk {
    paths: BTreeSet<String>,
    uncertainties: Vec<GraphUncertainty>,
    edges: Vec<ReachedEdge>,
    queue: VecDeque<(String, BTreeSet<String>)>,
    seen_exports: BTreeMap<String, BTreeSet<String>>,
    own_exports_propagated: BTreeSet<String>,
    /// Tracks exact changed target members behind `export * as ns from "./target"` per `(barrel, ns)`.
    ns_reexport_members: BTreeMap<(String, String), BTreeSet<String>>,
    /// Exports that changed directly (not exclusively via `export * as ns`), disabling member filtering.
    non_ns_exports: BTreeSet<(String, String)>,
}

impl DependencyGraph {
    pub fn reachability_from(&self, changed: impl IntoIterator<Item = String>) -> Reachability {
        let mut paths = changed.into_iter().collect::<BTreeSet<_>>();
        let mut q = paths.iter().cloned().collect::<VecDeque<_>>();
        while let Some(p) = q.pop_front() {
            if let Some(t) = self.module_index(&p) {
                for e in self.reverse(t) {
                    if let Some(s) = self
                        .imports
                        .get(*e as usize)
                        .and_then(|e| self.path(e.source))
                        && paths.insert(s.to_owned())
                    {
                        q.push_back(s.to_owned());
                    }
                }
            }
        }
        let uncertainties = self
            .uncertainties()
            .into_iter()
            .filter(|u| paths.contains(&u.path))
            .collect();
        Reachability {
            paths,
            uncertainties,
            edges: Vec::new(),
        }
    }

    pub fn symbol_reachability_from(
        &self,
        changed: impl IntoIterator<Item = String>,
    ) -> Reachability {
        self.symbol_reachability_with_options(changed, false)
    }

    /// Runtime symbol reachability for runtime test tasks: `import type` / `export type` edges are
    /// erased at runtime and therefore neither propagate runtime impact nor widen runtime tests.
    pub fn symbol_reachability_runtime(
        &self,
        changed: impl IntoIterator<Item = String>,
    ) -> Reachability {
        self.symbol_reachability_with_options(changed, true)
    }

    fn symbol_reachability_with_options(
        &self,
        changed: impl IntoIterator<Item = String>,
        erase_type_only: bool,
    ) -> Reachability {
        let mut walk = self.seed_changed_exports(changed, erase_type_only);
        self.walk_importers(&mut walk, erase_type_only);
        self.collect_uncertainties(&mut walk);
        Reachability {
            paths: walk.paths,
            uncertainties: walk.uncertainties,
            edges: walk.edges,
        }
    }

    /// A changed module enters the walk with its proven changed exports:
    /// - A comment-only edit (`complete && !semantic_change`) seeds neither path nor uncertainty.
    /// - A type-only declaration edit (`complete && type_only_change`) seeds nothing on the
    ///   runtime channel (`erase_type_only`), while still triggering typecheck.
    /// - A terminal leaf with no importers (e.g. a `*.test.ts` file) seeds only itself without
    ///   widening when `complete && exports.is_empty()`.
    /// - Any incomplete hunk or unattributed non-leaf change emits `unattributed-module-change`.
    fn seed_changed_exports(
        &self,
        changed: impl IntoIterator<Item = String>,
        erase_type_only: bool,
    ) -> SymbolWalk {
        let mut walk = SymbolWalk::default();
        for p in changed {
            match self.change(&p) {
                Some(c) if c.complete && !c.semantic_change => {}
                Some(c) if c.complete && c.type_only_change && erase_type_only => {}
                Some(c) if c.complete && !c.exports.is_empty() => {
                    walk.paths.insert(p.clone());
                    for sym in &c.exports {
                        walk.non_ns_exports.insert((p.clone(), sym.clone()));
                    }
                    enqueue_exports(&mut walk, p, c.exports);
                }
                Some(c)
                    if c.complete
                        && c.exports.is_empty()
                        && self
                            .module_index(&p)
                            .is_some_and(|module| self.reverse(module).is_empty()) =>
                {
                    walk.paths.insert(p);
                }
                _ => {
                    walk.paths.insert(p.clone());
                    walk.uncertainties.push(GraphUncertainty {
                        path: p,
                        code: "unattributed-module-change".into(),
                        message: "Changed exports could not be proven for every hunk.".into(),
                        scope: GraphUncertaintyScope::ReachedModule,
                        location: None,
                    });
                }
            }
        }
        walk
    }

    fn walk_importers(&self, walk: &mut SymbolWalk, erase_type_only: bool) {
        while let Some((p, exports)) = walk.queue.pop_front() {
            let Some(t) = self.module_index(&p) else {
                continue;
            };
            for edge_id in self.reverse(t) {
                let Some(e) = self.imports.get(*edge_id as usize) else {
                    continue;
                };
                let Some(source) = self.path(e.source).map(str::to_owned) else {
                    continue;
                };
                self.follow_edge(walk, e, source, &p, &exports, erase_type_only);
            }
        }
    }

    fn follow_edge(
        &self,
        walk: &mut SymbolWalk,
        e: &CImport,
        source: String,
        target: &str,
        exports: &BTreeSet<String>,
        erase_type_only: bool,
    ) {
        if e.type_only {
            if !erase_type_only {
                walk.uncertainties.push(ambiguous_import(source, e));
            }
            return;
        }
        if e.kind == ImportKind::ReExport && e.reexport_all {
            follow_reexport_all(walk, e, source, target, exports);
            return;
        }
        if let Some(ns_id) = e.reexport_namespace
            && let Some(ns_name) = self.str(ns_id)
        {
            follow_reexport_namespace(walk, e, source, target, ns_name, exports);
            return;
        }
        let runtime_module_dependency =
            e.kind == ImportKind::Runtime && !e.namespace && e.requested.is_empty();
        if e.namespace || (e.requested.is_empty() && !runtime_module_dependency) {
            walk.uncertainties.push(ambiguous_import(source, e));
            return;
        }
        let matched_exports = e
            .requested
            .iter()
            .filter_map(|id| self.str(*id).map(|name| (*id, name)))
            .filter(|(id, name)| {
                exports.contains(*name)
                    && self.matches_namespace_member_reads(walk, e, target, *id, name)
            })
            .map(|(_, name)| name.to_owned())
            .collect::<BTreeSet<_>>();
        if runtime_module_dependency || !matched_exports.is_empty() {
            walk.edges.push(ReachedEdge {
                importer: source.clone(),
                target: target.to_owned(),
                symbols: matched_exports.clone(),
                position: e.position,
            });
            walk.paths.insert(source.clone());
            if let Some(deps) = &e.export_deps {
                let mut affected = BTreeSet::new();
                for sym in &matched_exports {
                    if let Some(sym_id) = super::pack::string_id(&self.strings, sym)
                        && let Some((_, targets)) = deps.iter().find(|(k, _)| *k == sym_id)
                    {
                        for target_id in targets {
                            if let Some(name) = self.str(*target_id) {
                                affected.insert(name.to_owned());
                            }
                        }
                    }
                }
                if !affected.is_empty() {
                    for sym in &affected {
                        walk.non_ns_exports.insert((source.clone(), sym.clone()));
                    }
                    enqueue_exports(walk, source, affected);
                }
            } else if walk.own_exports_propagated.insert(source.clone()) {
                self.propagate_own_exports(walk, e.source, source);
            }
        }
    }

    fn matches_namespace_member_reads(
        &self,
        walk: &SymbolWalk,
        edge: &CImport,
        target: &str,
        symbol_id: u32,
        symbol_name: &str,
    ) -> bool {
        let key = (target.to_owned(), symbol_name.to_owned());
        if walk.non_ns_exports.contains(&key) {
            return true;
        }
        let Some(changed_members) = walk.ns_reexport_members.get(&key) else {
            return true;
        };
        let Some(reads_map) = &edge.member_reads else {
            return true;
        };
        let Some((_, read_ids)) = reads_map.iter().find(|(k, _)| *k == symbol_id) else {
            // Binding escaped (e.g. `Object.keys(ns)`): conservatively affected (`ns_reexport_escape_widens`).
            return true;
        };
        read_ids
            .iter()
            .filter_map(|id| self.str(*id))
            .any(|member| changed_members.contains(member))
    }

    /// A reached module carries the change onward through its own exports. A module that exports
    /// nothing yet has importers cannot say what they would see, so it stays uncertain.
    fn propagate_own_exports(&self, walk: &mut SymbolWalk, module: u32, source: String) {
        let next = self.exports(module);
        if next.is_empty() {
            if !self.reverse(module).is_empty() {
                walk.uncertainties.push(GraphUncertainty {
                    path: source,
                    code: "unattributed-transitive-export".into(),
                    message: "Reached module has no owned exports to propagate.".into(),
                    scope: GraphUncertaintyScope::ReachedModule,
                    location: None,
                });
            }
        } else {
            for sym in &next {
                walk.non_ns_exports.insert((source.clone(), sym.clone()));
            }
            enqueue_exports(walk, source, next);
        }
    }

    /// Frontend-declared uncertainties join the walk's own: workspace-wide ones whenever any
    /// semantic change entered the walk, and module ones where the walk actually reached.
    fn collect_uncertainties(&self, walk: &mut SymbolWalk) {
        if walk.paths.is_empty() && walk.uncertainties.is_empty() {
            return;
        }
        let declared = self
            .uncertainties()
            .into_iter()
            .filter(|uncertainty| {
                uncertainty.scope == GraphUncertaintyScope::WholeWorkspace
                    || walk.paths.contains(&uncertainty.path)
            })
            .collect::<Vec<_>>();
        walk.uncertainties.extend(declared);
        walk.uncertainties.sort_by(|a, b| {
            a.path
                .cmp(&b.path)
                .then(a.code.cmp(&b.code))
                .then(uncertainty_span_start(a).cmp(&uncertainty_span_start(b)))
        });
        walk.uncertainties.dedup();
    }
}

/// An `export *` re-export forwards every changed name but `default`, which it does not re-export.
fn follow_reexport_all(
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
    for sym in &reexported {
        walk.non_ns_exports.insert((source.clone(), sym.clone()));
    }
    enqueue_exports(walk, source, reexported);
}

/// An `export * as ns from "./target"` namespace re-export binds EVERY runtime export of `target`
/// (including `"default"`) under exported name `ns`, recording the exact changed member names so
/// tracked downstream `ns.foo` reads stay symbol-precise (`NamespaceAndImports.lean` Theorems 1–3).
fn follow_reexport_namespace(
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

/// Enqueues only `(module, symbol)` pairs not yet seen so diamond `export *` barrels and mixed
/// own-export + `export *` modules propagate every changed symbol without looping.
fn enqueue_exports(walk: &mut SymbolWalk, module: String, exports: BTreeSet<String>) {
    let seen = walk.seen_exports.entry(module.clone()).or_default();
    let fresh = exports
        .into_iter()
        .filter(|symbol| seen.insert(symbol.clone()))
        .collect::<BTreeSet<_>>();
    if !fresh.is_empty() {
        walk.queue.push_back((module, fresh));
    }
}

fn ambiguous_import(path: String, import: &CImport) -> GraphUncertainty {
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

fn uncertainty_span_start(uncertainty: &GraphUncertainty) -> Option<u32> {
    uncertainty
        .location
        .as_ref()
        .map(|location| location.span.start)
}
