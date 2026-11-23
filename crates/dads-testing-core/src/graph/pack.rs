//! Packing public frontend facts into the compact representation: intern the symbols, pack the
//! modules with their imports, then derive the reverse adjacency the traversal walks.
use super::compact::{CImport, CModule, CUncertainty, DependencyGraph};
use super::types::{
    ChangedModuleEvidence, GraphUncertainty, ImportFact, ModuleNode, SourceSpan, SymbolFact,
};
use std::collections::{BTreeMap, BTreeSet};

impl DependencyGraph {
    pub(super) fn pack(
        mut nodes: Vec<ModuleNode>,
        uncertainties: Vec<GraphUncertainty>,
        changes: Vec<ChangedModuleEvidence>,
    ) -> Self {
        let strings = intern_symbols(&nodes, &uncertainties, &changes);
        nodes.sort_by(|a, b| a.path.cmp(&b.path));
        let (modules, imports) = pack_modules(nodes, &strings);
        let (reverse_offsets, reverse_edges) = pack_reverse_edges(&modules, &imports);
        let mut g = Self {
            strings,
            modules,
            imports,
            reverse_offsets,
            reverse_edges,
            uncertainties: Vec::new(),
            changes: Vec::new(),
        };
        g.uncertainties = pack_uncertainties(uncertainties, &g.strings);
        g.changes = g.pack_changes(changes);
        g
    }
}

/// The sorted intern table. Every string the packed graph can name is collected first so that a
/// symbol's identity is its index, and lookup is a binary search.
fn intern_symbols(
    nodes: &[ModuleNode],
    uncertainties: &[GraphUncertainty],
    changes: &[ChangedModuleEvidence],
) -> Vec<String> {
    let mut table = BTreeSet::new();
    for n in nodes {
        table.insert(n.path.clone());
        table.insert(n.language.clone());
        for s in n.declarations.iter().chain(n.references.iter()) {
            table.insert(s.name.clone());
        }
        for i in &n.imports {
            table.insert(i.specifier.clone());
            for s in &i.requested_symbols {
                table.insert(s.clone());
            }
            if let Some(p) = &i.resolved_path {
                table.insert(p.clone());
            }
            if let Some(deps) = &i.export_deps {
                for (k, vs) in deps {
                    table.insert(k.clone());
                    for v in vs {
                        table.insert(v.clone());
                    }
                }
            }
        }
    }
    for u in uncertainties {
        table.insert(u.path.clone());
        table.insert(u.code.clone());
        table.insert(u.message.clone());
    }
    for c in changes {
        table.insert(c.path.clone());
        for s in &c.changed_exports {
            table.insert(s.clone());
        }
    }
    table.into_iter().collect()
}

pub(super) fn string_id(strings: &[String], value: &str) -> Option<u32> {
    strings
        .binary_search_by(|x| x.as_str().cmp(value))
        .ok()
        .and_then(|x| u32::try_from(x).ok())
}

/// Packs path-sorted modules and, in the same pass, the flat import table each module owns a
/// contiguous window of.
fn pack_modules(nodes: Vec<ModuleNode>, strings: &[String]) -> (Vec<CModule>, Vec<CImport>) {
    let paths = nodes
        .iter()
        .enumerate()
        .filter_map(|(i, n)| string_id(strings, &n.path).zip(u32::try_from(i).ok()))
        .collect::<BTreeMap<_, _>>();
    let mut modules = Vec::new();
    let mut imports = Vec::new();
    for (i, n) in nodes.into_iter().enumerate() {
        let Some(source) = u32::try_from(i).ok() else {
            continue;
        };
        let start = u32::try_from(imports.len()).unwrap_or(u32::MAX);
        pack_imports(n.imports, source, &paths, strings, &mut imports);
        let count = u32::try_from(imports.len())
            .ok()
            .and_then(|e| e.checked_sub(start))
            .unwrap_or(0);
        if let (Some(path), Some(language)) =
            (string_id(strings, &n.path), string_id(strings, &n.language))
        {
            modules.push(CModule {
                path,
                language,
                declarations: pack_symbols(n.declarations, strings),
                references: pack_symbols(n.references, strings),
                start,
                count,
            });
        }
    }
    (modules, imports)
}

fn pack_symbols(facts: Vec<SymbolFact>, strings: &[String]) -> Vec<(u32, SourceSpan)> {
    facts
        .into_iter()
        .filter_map(|s| string_id(strings, &s.name).map(|n| (n, s.span)))
        .collect()
}

/// An import whose specifier or requested symbols are not in the intern table cannot be named, so
/// it is dropped rather than packed as an unresolvable edge.
fn pack_imports(
    facts: Vec<ImportFact>,
    source: u32,
    paths: &BTreeMap<u32, u32>,
    strings: &[String],
    out: &mut Vec<CImport>,
) {
    for x in facts {
        let (Some(specifier), Some(requested)) = (
            string_id(strings, &x.specifier),
            x.requested_symbols
                .iter()
                .map(|s| string_id(strings, s))
                .collect::<Option<Vec<_>>>(),
        ) else {
            continue;
        };
        let target = x
            .resolved_path
            .as_deref()
            .and_then(|p| string_id(strings, p))
            .and_then(|p| paths.get(&p).copied());
        let export_deps = x.export_deps.as_ref().map(|deps| {
            deps.iter()
                .filter_map(|(k, vs)| {
                    let key = string_id(strings, k)?;
                    let vals = vs
                        .iter()
                        .filter_map(|v| string_id(strings, v))
                        .collect::<Vec<_>>();
                    Some((key, vals))
                })
                .collect::<Vec<_>>()
        });
        out.push(CImport {
            source,
            specifier,
            span: x.span,
            kind: x.kind,
            type_only: x.type_only,
            requested,
            namespace: x.namespace_import,
            reexport_all: x.reexport_all,
            target,
            position: x.position,
            export_deps,
        });
    }
}

/// Importer edges grouped by the module they point at, so a target's importers are one slice.
fn pack_reverse_edges(modules: &[CModule], imports: &[CImport]) -> (Vec<u32>, Vec<u32>) {
    let mut incoming = vec![Vec::new(); modules.len()];
    for (eid, e) in imports.iter().enumerate() {
        if let (Some(t), Some(eid)) = (e.target, u32::try_from(eid).ok())
            && let Some(v) = incoming.get_mut(t as usize)
        {
            v.push(eid);
        }
    }
    let mut offsets = vec![0];
    let mut reverse = Vec::new();
    for v in incoming {
        reverse.extend(v);
        offsets.push(u32::try_from(reverse.len()).unwrap_or(u32::MAX));
    }
    (offsets, reverse)
}

fn pack_uncertainties(
    uncertainties: Vec<GraphUncertainty>,
    strings: &[String],
) -> Vec<CUncertainty> {
    uncertainties
        .into_iter()
        .filter_map(|u| {
            Some(CUncertainty {
                path: string_id(strings, &u.path)?,
                code: string_id(strings, &u.code)?,
                message: string_id(strings, &u.message)?,
                scope: u.scope,
                location: u.location,
            })
        })
        .collect()
}
