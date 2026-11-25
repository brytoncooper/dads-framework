//! The packed representation: one sorted intern table, u32 module/import IDs, packed reverse
//! adjacency, and the lookups that read it back as public facts.
use super::pack;
use super::types::{
    ChangedModuleEvidence, GraphUncertainty, GraphUncertaintyScope, ImportFact, ImportKind,
    LineColumn, ModuleNode, SourceLocation, SourceSpan, SymbolFact,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct CModule {
    pub(super) path: u32,
    pub(super) language: u32,
    pub(super) declarations: Vec<(u32, SourceSpan)>,
    pub(super) references: Vec<(u32, SourceSpan)>,
    pub(super) start: u32,
    pub(super) count: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct CImport {
    pub(super) source: u32,
    pub(super) specifier: u32,
    pub(super) span: SourceSpan,
    pub(super) kind: ImportKind,
    pub(super) type_only: bool,
    pub(super) requested: Vec<u32>,
    pub(super) namespace: bool,
    #[serde(default)]
    pub(super) reexport_all: bool,
    #[serde(default)]
    pub(super) reexport_namespace: Option<u32>,
    pub(super) target: Option<u32>,
    #[serde(default)]
    pub(super) position: Option<LineColumn>,
    #[serde(default)]
    pub(super) export_deps: Option<Vec<(u32, Vec<u32>)>>,
    #[serde(default)]
    pub(super) member_reads: Option<Vec<(u32, Vec<u32>)>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct CUncertainty {
    pub(super) path: u32,
    pub(super) code: u32,
    pub(super) message: u32,
    #[serde(default)]
    pub(super) scope: GraphUncertaintyScope,
    #[serde(default)]
    pub(super) location: Option<SourceLocation>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct CChange {
    pub(super) path: u32,
    pub(super) exports: Vec<u32>,
    pub(super) complete: bool,
    #[serde(default = "default_semantic_change")]
    pub(super) semantic_change: bool,
    #[serde(default)]
    pub(super) type_only_change: bool,
    #[serde(default)]
    pub(super) module_eval_changed: bool,
}

fn default_semantic_change() -> bool {
    true
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DependencyGraph {
    pub(super) strings: Vec<String>,
    pub(super) modules: Vec<CModule>,
    pub(super) imports: Vec<CImport>,
    pub(super) reverse_offsets: Vec<u32>,
    pub(super) reverse_edges: Vec<u32>,
    pub(super) uncertainties: Vec<CUncertainty>,
    pub(super) changes: Vec<CChange>,
}

impl DependencyGraph {
    pub fn new(nodes: Vec<ModuleNode>, uncertainties: Vec<GraphUncertainty>) -> Self {
        Self::pack(nodes, uncertainties, Vec::new())
    }
    pub fn with_changed_module_evidence(mut self, changes: Vec<ChangedModuleEvidence>) -> Self {
        self.changes = self.pack_changes(changes);
        self
    }
    pub fn contains_path(&self, path: &str) -> bool {
        self.module_index(path).is_some()
    }
    pub fn has_importers(&self, path: &str) -> bool {
        self.module_index(path)
            .is_some_and(|m| !self.reverse(m).is_empty())
    }

    /// Returns every workspace module path that statically imports or requires any external npm
    /// package whose normalized package name appears in `packages`.
    pub fn modules_importing_external_packages(&self, packages: &BTreeSet<String>) -> Vec<String> {
        if packages.is_empty() {
            return Vec::new();
        }
        let mut matched = BTreeSet::new();
        for import in &self.imports {
            if import.target.is_some() {
                continue;
            }
            let Some(specifier) = self.str(import.specifier) else {
                continue;
            };
            if let Some(pkg) = external_package_name(specifier)
                && packages.contains(pkg)
                && let Some(source_path) = self.str(self.modules[import.source as usize].path)
            {
                matched.insert(source_path.to_owned());
            }
        }
        matched.into_iter().collect()
    }

    /// Returns every workspace module path that has an import or re-export whose raw specifier
    /// matches any of the given TypeScript `compilerOptions.paths` alias patterns.
    ///
    /// Unlike `modules_importing_external_packages`, this checks both resolved (`target.is_some()`)
    /// and unresolved (`target.is_none()`) imports because a modified alias resolves to a workspace
    /// module while a removed alias no longer resolves.
    pub fn modules_matching_path_aliases(&self, aliases: &BTreeSet<String>) -> Vec<String> {
        if aliases.is_empty() {
            return Vec::new();
        }
        let mut matched = BTreeSet::new();
        for import in &self.imports {
            let Some(specifier) = self.str(import.specifier) else {
                continue;
            };
            if aliases
                .iter()
                .any(|pattern| crate::tsconfig_parse::specifier_matches_alias(specifier, pattern))
                && let Some(source_path) = self.str(self.modules[import.source as usize].path)
            {
                matched.insert(source_path.to_owned());
            }
        }
        matched.into_iter().collect()
    }
    pub fn has_uncertainty(&self) -> bool {
        !self.uncertainties.is_empty()
    }
    pub fn whole_workspace_uncertainties(&self) -> Vec<GraphUncertainty> {
        self.uncertainties()
            .into_iter()
            .filter(|u| u.scope == GraphUncertaintyScope::WholeWorkspace)
            .collect()
    }
    pub fn changed_module_evidences(&self) -> Vec<ChangedModuleEvidence> {
        self.changes
            .iter()
            .filter_map(|c| {
                Some(ChangedModuleEvidence {
                    path: self.str(c.path)?.to_owned(),
                    changed_exports: c
                        .exports
                        .iter()
                        .filter_map(|n| self.str(*n).map(str::to_owned))
                        .collect(),
                    every_hunk_is_attributed: c.complete,
                    semantic_change: c.semantic_change,
                    type_only_change: c.type_only_change,
                    module_eval_changed: c.module_eval_changed,
                })
            })
            .collect()
    }
    pub fn materialize_modules(&self) -> Vec<ModuleNode> {
        (0..self.modules.len())
            .filter_map(|i| self.materialize(i as u32))
            .collect()
    }
    pub fn patch_modules(
        self,
        nodes: Vec<ModuleNode>,
        changes: Vec<ChangedModuleEvidence>,
        uncertainties: Vec<GraphUncertainty>,
    ) -> Self {
        let mut all = self
            .materialize_modules()
            .into_iter()
            .map(|n| (n.path.clone(), n))
            .collect::<BTreeMap<_, _>>();
        for n in nodes {
            all.insert(n.path.clone(), n);
        }
        let mut us = Vec::new();
        us.extend(uncertainties);
        Self::pack(all.into_values().collect(), us, changes)
    }
    /// Returns the proven changed exports of a path, and nothing when the change evidence for that
    /// path is incomplete. An incomplete change has no attributable export identity to explain.
    pub fn changed_exports(&self, path: &str) -> Option<BTreeSet<String>> {
        let change = self.change(path)?;
        change.complete.then_some(change.exports)
    }
    /// Returns whether the change evidence for `path` indicates a top-level module-evaluation change.
    pub fn module_eval_changed(&self, path: &str) -> bool {
        self.change(path)
            .is_some_and(|change| change.complete && change.module_eval_changed)
    }
    pub(super) fn pack_changes(&self, changes: Vec<ChangedModuleEvidence>) -> Vec<CChange> {
        changes
            .into_iter()
            .filter_map(|c| {
                Some(CChange {
                    path: self.id(&c.path)?,
                    exports: c
                        .changed_exports
                        .iter()
                        .map(|s| self.id(s))
                        .collect::<Option<Vec<_>>>()?,
                    complete: c.every_hunk_is_attributed,
                    semantic_change: c.semantic_change,
                    type_only_change: c.type_only_change,
                    module_eval_changed: c.module_eval_changed,
                })
            })
            .collect()
    }
    pub(super) fn id(&self, s: &str) -> Option<u32> {
        pack::string_id(&self.strings, s)
    }
    pub(super) fn str(&self, id: u32) -> Option<&str> {
        self.strings.get(id as usize).map(String::as_str)
    }
    pub(super) fn path(&self, m: u32) -> Option<&str> {
        self.modules.get(m as usize).and_then(|x| self.str(x.path))
    }
    pub(super) fn module_index(&self, p: &str) -> Option<u32> {
        let id = self.id(p)?;
        self.modules
            .binary_search_by_key(&id, |m| m.path)
            .ok()
            .and_then(|x| u32::try_from(x).ok())
    }
    pub(super) fn reverse(&self, m: u32) -> &[u32] {
        let Some(a) = self
            .reverse_offsets
            .get(m as usize)
            .and_then(|x| usize::try_from(*x).ok())
        else {
            return &[];
        };
        let Some(b) = self
            .reverse_offsets
            .get(m as usize + 1)
            .and_then(|x| usize::try_from(*x).ok())
        else {
            return &[];
        };
        self.reverse_edges.get(a..b).unwrap_or(&[])
    }
    pub(super) fn exports(&self, m: u32) -> BTreeSet<String> {
        self.modules
            .get(m as usize)
            .map(|x| {
                x.declarations
                    .iter()
                    .filter_map(|(n, _)| self.str(*n).map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }
    pub(super) fn change(&self, p: &str) -> Option<CChangeView> {
        let id = self.id(p)?;
        self.changes
            .iter()
            .find(|x| x.path == id)
            .map(|x| CChangeView {
                exports: x
                    .exports
                    .iter()
                    .filter_map(|n| self.str(*n).map(str::to_owned))
                    .collect(),
                complete: x.complete,
                semantic_change: x.semantic_change,
                type_only_change: x.type_only_change,
                module_eval_changed: x.module_eval_changed,
            })
    }
    pub fn uncertainties(&self) -> Vec<GraphUncertainty> {
        self.uncertainties
            .iter()
            .filter_map(|x| {
                Some(GraphUncertainty {
                    path: self.str(x.path)?.to_owned(),
                    code: self.str(x.code)?.to_owned(),
                    message: self.str(x.message)?.to_owned(),
                    scope: x.scope,
                    location: x.location.clone(),
                })
            })
            .collect()
    }
    fn materialize(&self, i: u32) -> Option<ModuleNode> {
        let m = self.modules.get(i as usize)?;
        let start = usize::try_from(m.start).ok()?;
        let end = start.checked_add(usize::try_from(m.count).ok()?)?;
        Some(ModuleNode {
            path: self.str(m.path)?.to_owned(),
            language: self.str(m.language)?.to_owned(),
            declarations: self.materialize_symbols(&m.declarations),
            references: self.materialize_symbols(&m.references),
            imports: self
                .imports
                .get(start..end)?
                .iter()
                .filter_map(|x| self.materialize_import(x))
                .collect(),
        })
    }
    fn materialize_symbols(&self, packed: &[(u32, SourceSpan)]) -> Vec<SymbolFact> {
        packed
            .iter()
            .filter_map(|(n, s)| {
                self.str(*n).map(|n| SymbolFact {
                    name: n.to_owned(),
                    span: s.clone(),
                })
            })
            .collect()
    }
    fn materialize_import(&self, x: &CImport) -> Option<ImportFact> {
        Some(ImportFact {
            specifier: self.str(x.specifier)?.to_owned(),
            span: x.span.clone(),
            kind: x.kind,
            type_only: x.type_only,
            requested_symbols: x
                .requested
                .iter()
                .filter_map(|n| self.str(*n).map(str::to_owned))
                .collect(),
            namespace_import: x.namespace,
            reexport_all: x.reexport_all,
            reexport_namespace: x
                .reexport_namespace
                .and_then(|n| self.str(n).map(str::to_owned)),
            resolved_path: x.target.and_then(|t| self.path(t).map(str::to_owned)),
            position: x.position,
            export_deps: self.materialize_symbol_map(x.export_deps.as_deref()),
            member_reads: self.materialize_symbol_map(x.member_reads.as_deref()),
        })
    }
    fn materialize_symbol_map(
        &self,
        packed: Option<&[(u32, Vec<u32>)]>,
    ) -> Option<BTreeMap<String, BTreeSet<String>>> {
        packed.map(|entries| {
            entries
                .iter()
                .filter_map(|(k, vs)| {
                    let key = self.str(*k)?.to_owned();
                    let vals = vs
                        .iter()
                        .filter_map(|v| self.str(*v).map(str::to_owned))
                        .collect();
                    Some((key, vals))
                })
                .collect()
        })
    }
}

pub(super) struct CChangeView {
    pub(super) exports: BTreeSet<String>,
    pub(super) complete: bool,
    pub(super) semantic_change: bool,
    pub(super) type_only_change: bool,
    pub(super) module_eval_changed: bool,
}

/// Extracts the npm package name from a bare module specifier (`"zod/v4"` -> `"zod"`,
/// `"@scope/pkg/subpath"` -> `"@scope/pkg"`). Relative, absolute, `node:`, and `virtual:`
/// specifiers return `None`.
pub fn external_package_name(specifier: &str) -> Option<&str> {
    if specifier.is_empty()
        || specifier.starts_with('.')
        || specifier.starts_with('/')
        || specifier.starts_with('#')
        || specifier.starts_with("node:")
        || specifier.starts_with("virtual:")
        || specifier.starts_with('\0')
    {
        return None;
    }
    if let Some(rest) = specifier.strip_prefix('@') {
        let slash = rest.find('/')?;
        let after_scope = &rest[slash + 1..];
        if after_scope.is_empty() {
            return None;
        }
        let pkg_len = match after_scope.find('/') {
            Some(sub) => 1 + slash + 1 + sub,
            None => specifier.len(),
        };
        Some(&specifier[..pkg_len])
    } else {
        let pkg_len = specifier.find('/').unwrap_or(specifier.len());
        (pkg_len > 0).then_some(&specifier[..pkg_len])
    }
}
