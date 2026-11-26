//! Reverse traversal: which modules a change reaches, and where the answer stops being provable.
use super::compact::{CImport, DependencyGraph};
use super::queries::file_read_dir_prefixes;
use super::reachability_walk::{
    SymbolWalk, ambiguous_import, enqueue_direct_exports, follow_reexport_all,
    follow_reexport_namespace, is_pure_side_effect_import, unattributed_change,
    uncertainty_span_start,
};
use super::types::{
    GraphUncertainty, GraphUncertaintyScope, ImportKind, Reachability, ReachedEdge,
};
use std::collections::{BTreeSet, VecDeque};

impl DependencyGraph {
    pub fn reachability_from(&self, changed: impl IntoIterator<Item = String>) -> Reachability {
        let direct = changed.into_iter().collect::<BTreeSet<_>>();
        let mut paths = direct.clone();
        let mut q = paths.iter().cloned().collect::<VecDeque<_>>();
        while let Some(p) = q.pop_front() {
            let is_direct = direct.contains(&p);
            if let Some(t) = self.module_index(&p) {
                for e in self.reverse(t) {
                    if let Some(imp) = self.imports.get(*e as usize)
                        && (is_direct || imp.kind != ImportKind::FileRead)
                        && let Some(s) = self.path(imp.source)
                        && paths.insert(s.to_owned())
                    {
                        q.push_back(s.to_owned());
                    }
                }
            }
            if is_direct {
                for dir in file_read_dir_prefixes(&p) {
                    for (imp, source) in self.reverse_import_sources(&dir) {
                        if imp.kind == ImportKind::FileRead && paths.insert(source.clone()) {
                            q.push_back(source);
                        }
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

    /// Follows direct `ImportKind::FileRead` edges (including directory reads) for changed paths
    /// that have no module node in the graph (for example a deleted file inside a `readdirSync` dir).
    pub fn file_read_reachability(
        &self,
        changed: impl IntoIterator<Item = String>,
        erase_type_only: bool,
    ) -> Reachability {
        let mut walk = SymbolWalk::default();
        for path in changed {
            self.follow_direct_file_reads(&mut walk, &path, erase_type_only);
        }
        self.walk_importers(&mut walk, erase_type_only);
        self.collect_uncertainties(&mut walk);
        Reachability {
            paths: walk.paths,
            uncertainties: walk.uncertainties,
            edges: walk.edges,
        }
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
            let matched_file_read_dir =
                self.follow_direct_file_reads(&mut walk, &p, erase_type_only);
            if p.starts_with("fs-dir:") {
                walk.paths.insert(p);
                continue;
            }
            match self.change(&p) {
                Some(c) if c.complete && !c.semantic_change => {}
                Some(c) if c.complete && c.type_only_change && erase_type_only => {}
                Some(c) if c.complete && c.type_only_change && !erase_type_only => {
                    if let Some(type_exports) = c.type_exports {
                        walk.paths.insert(p.clone());
                        if !type_exports.is_empty() {
                            enqueue_direct_exports(&mut walk, p, type_exports);
                        }
                    } else if self
                        .module_index(&p)
                        .is_some_and(|module| !self.has_non_file_read_reverse(module))
                    {
                        walk.paths.insert(p);
                    } else {
                        walk.paths.insert(p.clone());
                        walk.uncertainties.push(unattributed_change(p));
                    }
                }
                Some(c) if c.complete && (c.module_eval_changed || !c.exports.is_empty()) => {
                    walk.paths.insert(p.clone());
                    if c.module_eval_changed && walk.seen_module_eval.insert(p.clone()) {
                        walk.module_eval_queue.push_back(p.clone());
                    }
                    let mut combined = c.exports;
                    if !erase_type_only
                        && let Some(type_exports) = c.type_exports
                    {
                        combined.extend(type_exports);
                    }
                    if !combined.is_empty() {
                        enqueue_direct_exports(&mut walk, p, combined);
                    }
                }
                Some(c)
                    if c.complete
                        && c.exports.is_empty()
                        && self
                            .module_index(&p)
                            .is_some_and(|module| !self.has_non_file_read_reverse(module)) =>
                {
                    walk.paths.insert(p);
                }
                None if self.module_index(&p).is_none() && matched_file_read_dir => {
                    walk.paths.insert(p);
                }
                _ => {
                    walk.paths.insert(p.clone());
                    walk.uncertainties.push(unattributed_change(p));
                }
            }
        }
        walk
    }

    fn follow_direct_file_reads(
        &self,
        walk: &mut SymbolWalk,
        target: &str,
        erase_type_only: bool,
    ) -> bool {
        let mut follow_for_key = |key: &str| -> bool {
            let mut matched = false;
            for (e, source) in self.reverse_import_sources(key) {
                if !self.is_file_read_edge(e) {
                    continue;
                }
                matched = true;
                walk.edges.push(ReachedEdge {
                    importer: source.clone(),
                    target: target.to_owned(),
                    symbols: BTreeSet::new(),
                    position: e.position,
                });
                walk.paths.insert(source.clone());
                if walk.own_exports_propagated.insert(source.clone()) {
                    self.propagate_own_exports(walk, e.source, source, erase_type_only);
                }
            }
            matched
        };
        follow_for_key(target);
        let mut matched_dir = false;
        for dir in file_read_dir_prefixes(target) {
            matched_dir |= follow_for_key(&dir);
        }
        matched_dir
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
        while !walk.module_eval_queue.is_empty() || !walk.queue.is_empty() {
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
    }

    fn follow_module_eval_edge(
        &self,
        walk: &mut SymbolWalk,
        e: &CImport,
        source: String,
        target: &str,
        _erase_type_only: bool,
    ) {
        if self.is_file_read_edge(e) || e.type_only {
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
        if self.is_file_read_edge(e) {
            return;
        }
        if e.type_only && erase_type_only {
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
        if e.kind == ImportKind::Static && is_pure_side_effect_import(e) {
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
                self.propagate_own_exports(walk, e.source, source, erase_type_only);
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

    /// A reached module carries the change onward through its own exports. When it exports nothing:
    /// - `FileRead` edges are ignored (bytes on disk did not change).
    /// - Pure side-effect runtime imports propagate through `module_eval_queue`.
    /// - Any reverse JS edge requesting named exports, namespace, or re-exports stays uncertain.
    fn propagate_own_exports(
        &self,
        walk: &mut SymbolWalk,
        module: u32,
        source: String,
        erase_type_only: bool,
    ) {
        let next = self.exports(module);
        if !next.is_empty() {
            enqueue_direct_exports(walk, source, next);
            return;
        }
        let mut has_unattributed_reverse = false;
        for (e, importer) in self.reverse_import_sources(&source) {
            if e.kind == ImportKind::FileRead || (e.type_only && erase_type_only) {
                continue;
            }
            if is_pure_side_effect_import(e) {
                self.follow_module_eval_edge(walk, e, importer, &source, erase_type_only);
            } else {
                has_unattributed_reverse = true;
            }
        }
        if has_unattributed_reverse {
            walk.uncertainties.push(GraphUncertainty {
                path: source,
                code: "unattributed-transitive-export".into(),
                message: "Reached module has no owned exports to propagate.".into(),
                scope: GraphUncertaintyScope::ReachedModule,
                location: None,
            });
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
