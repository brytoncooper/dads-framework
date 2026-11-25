//! Reverse traversal: which modules a change reaches, and where the answer stops being provable.
use super::compact::{CImport, DependencyGraph};
use super::reachability_helpers::{
    SymbolWalk, ambiguous_import, enqueue_direct_exports, follow_reexport_all,
    follow_reexport_namespace, uncertainty_span_start,
};
use super::types::{
    GraphUncertainty, GraphUncertaintyScope, ImportKind, Reachability, ReachedEdge,
};
use std::collections::{BTreeSet, VecDeque};

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
    /// - Raw `fs:` / `fs-dir:` readers always fire when their target path changed directly.
    /// - Comment-only or runtime-erased type-only edits skip JS export propagation.
    /// - A terminal leaf with no non-`fs:` importers seeds only itself without widening.
    fn seed_changed_exports(
        &self,
        changed: impl IntoIterator<Item = String>,
        erase_type_only: bool,
    ) -> SymbolWalk {
        let mut walk = SymbolWalk::default();
        for p in changed {
            self.follow_fs_direct_readers(&mut walk, &p, erase_type_only);
            if p.starts_with("fs-dir:") {
                walk.paths.insert(p);
                continue;
            }
            match self.change(&p) {
                Some(c) if c.complete && !c.semantic_change => {}
                Some(c) if c.complete && c.type_only_change && erase_type_only => {}
                Some(c) if c.complete && (c.module_eval_changed || !c.exports.is_empty()) => {
                    walk.paths.insert(p.clone());
                    if c.module_eval_changed && walk.seen_module_eval.insert(p.clone()) {
                        walk.module_eval_queue.push_back(p.clone());
                    }
                    if !c.exports.is_empty() {
                        enqueue_direct_exports(&mut walk, p, c.exports);
                    }
                }
                Some(c)
                    if c.complete
                        && c.exports.is_empty()
                        && self
                            .module_index(&p)
                            .is_some_and(|module| !self.has_non_fs_reverse(module)) =>
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

    fn is_fs_read_edge(&self, e: &CImport) -> bool {
        self.str(e.specifier)
            .is_some_and(|s| s.starts_with("fs:") || s.starts_with("fs-dir:"))
    }

    pub(super) fn has_non_fs_reverse(&self, module: u32) -> bool {
        self.reverse(module).iter().any(|edge_id| {
            self.imports
                .get(*edge_id as usize)
                .is_some_and(|e| !self.is_fs_read_edge(e))
        })
    }

    fn follow_fs_direct_readers(&self, walk: &mut SymbolWalk, target: &str, erase_type_only: bool) {
        for (e, source) in self.reverse_import_sources(target) {
            if self.is_fs_read_edge(e) {
                self.record_module_eval_hit(walk, e, source, target, erase_type_only);
            }
        }
    }

    fn reverse_import_sources<'a>(&'a self, target: &str) -> Vec<(&'a CImport, String)> {
        let Some(t) = self.module_index(target) else {
            return Vec::new();
        };
        self.reverse(t)
            .iter()
            .filter_map(|edge_id| {
                let e = self.imports.get(*edge_id as usize)?;
                let source = self.path(e.source)?.to_owned();
                Some((e, source))
            })
            .collect()
    }

    fn walk_importers(&self, walk: &mut SymbolWalk, erase_type_only: bool) {
        while let Some(p) = walk.module_eval_queue.pop_front() {
            for (e, source) in self.reverse_import_sources(&p) {
                self.follow_module_eval_edge(walk, e, source, &p, erase_type_only);
            }
        }
        while let Some((p, exports)) = walk.queue.pop_front() {
            for (e, source) in self.reverse_import_sources(&p) {
                self.follow_edge(walk, e, source, &p, &exports, erase_type_only);
            }
        }
    }

    fn follow_module_eval_edge(
        &self,
        walk: &mut SymbolWalk,
        e: &CImport,
        source: String,
        target: &str,
        erase_type_only: bool,
    ) {
        if self.is_fs_read_edge(e) {
            return;
        }
        self.record_module_eval_hit(walk, e, source, target, erase_type_only);
    }

    fn record_module_eval_hit(
        &self,
        walk: &mut SymbolWalk,
        e: &CImport,
        source: String,
        target: &str,
        erase_type_only: bool,
    ) {
        if e.type_only {
            if !erase_type_only {
                walk.uncertainties.push(ambiguous_import(source, e));
            }
            return;
        }
        walk.edges.push(ReachedEdge {
            importer: source.clone(),
            target: target.to_owned(),
            symbols: BTreeSet::new(),
            position: e.position,
        });
        walk.paths.insert(source.clone());
        if walk.seen_module_eval.insert(source.clone()) {
            walk.module_eval_queue.push_back(source);
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
        if self.is_fs_read_edge(e) {
            return;
        }
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
                    enqueue_direct_exports(walk, source, affected);
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
            if self.has_non_fs_reverse(module) {
                walk.uncertainties.push(GraphUncertainty {
                    path: source,
                    code: "unattributed-transitive-export".into(),
                    message: "Reached module has no owned exports to propagate.".into(),
                    scope: GraphUncertaintyScope::ReachedModule,
                    location: None,
                });
            }
        } else {
            enqueue_direct_exports(walk, source, next);
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
