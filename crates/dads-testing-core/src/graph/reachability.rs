//! Reverse traversal: which modules a change reaches, and where the answer stops being provable.
use super::compact::{CImport, DependencyGraph};
use super::types::{
    GraphUncertainty, GraphUncertaintyScope, ImportKind, Reachability, ReachedEdge, SourceLocation,
};
use std::collections::{BTreeSet, VecDeque};

/// The state one symbol-level walk carries: what it has reached, what it could not prove, the
/// edges it followed, and the reached modules whose own exports still have to be propagated.
#[derive(Default)]
struct SymbolWalk {
    paths: BTreeSet<String>,
    uncertainties: Vec<GraphUncertainty>,
    edges: Vec<ReachedEdge>,
    queue: VecDeque<(String, BTreeSet<String>)>,
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
        let mut walk = self.seed_changed_exports(changed);
        self.walk_importers(&mut walk);
        self.collect_uncertainties(&mut walk);
        Reachability {
            paths: walk.paths,
            uncertainties: walk.uncertainties,
            edges: walk.edges,
        }
    }

    /// A changed module enters the walk with its proven changed exports. A change whose hunks
    /// could not all be attributed has no export identity to follow, so it stays uncertain.
    fn seed_changed_exports(&self, changed: impl IntoIterator<Item = String>) -> SymbolWalk {
        let mut walk = SymbolWalk::default();
        for p in changed {
            walk.paths.insert(p.clone());
            match self.change(&p) {
                Some(c) if c.complete && !c.exports.is_empty() => {
                    walk.queue.push_back((p, c.exports));
                }
                _ => {
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

    fn walk_importers(&self, walk: &mut SymbolWalk) {
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
                self.follow_edge(walk, e, source, &p, &exports);
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
    ) {
        if e.type_only {
            walk.uncertainties.push(ambiguous_import(source, e));
            return;
        }
        if e.kind == ImportKind::ReExport && e.reexport_all {
            follow_reexport_all(walk, e, source, target, exports);
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
            .filter_map(|id| self.str(*id))
            .filter(|n| exports.contains(*n))
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        if runtime_module_dependency || !matched_exports.is_empty() {
            walk.edges.push(ReachedEdge {
                importer: source.clone(),
                target: target.to_owned(),
                symbols: matched_exports,
                position: e.position,
            });
            if walk.paths.insert(source.clone()) {
                self.propagate_own_exports(walk, e.source, source);
            }
        }
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
            walk.queue.push_back((source, next));
        }
    }

    /// Frontend-declared uncertainties join the walk's own: workspace-wide ones always, module
    /// ones only where the walk actually reached. The result is sorted so it is stable to compare.
    fn collect_uncertainties(&self, walk: &mut SymbolWalk) {
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
    if walk.paths.insert(source.clone()) {
        walk.queue.push_back((source, reexported));
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
