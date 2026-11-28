//! Graph-level lookup queries over packed modules and imports (external packages, tsconfig path
//! aliases, importer checks, and directory `FileRead` coverage).
use super::compact::DependencyGraph;
use super::types::ImportKind;
use std::collections::BTreeSet;

impl DependencyGraph {
    pub fn has_importers(&self, path: &str) -> bool {
        self.module_index(path)
            .is_some_and(|m| self.has_non_file_read_reverse(m))
    }

    pub fn project_has_standard_tests(&self, project_root: &str) -> bool {
        self.modules
            .iter()
            .filter_map(|m| self.str(m.path))
            .any(|p| {
                crate::scope::path_is_inside(p, project_root)
                    && crate::scope::is_standard_test_path(p)
            })
    }

    pub fn has_file_read_dir_for(&self, path: &str) -> bool {
        file_read_dir_prefixes(path).into_iter().any(|dir| {
            self.module_index(&dir).is_some_and(|m| {
                self.reverse(m).iter().any(|edge_id| {
                    self.imports
                        .get(*edge_id as usize)
                        .is_some_and(|edge| edge.kind == ImportKind::FileRead)
                })
            })
        })
    }

    pub(super) fn is_file_read_edge(&self, edge: &super::compact::CImport) -> bool {
        edge.kind == ImportKind::FileRead
            || self
                .str(edge.specifier)
                .is_some_and(|s| s.starts_with("fs:") || s.starts_with("fs-dir:"))
    }

    pub(super) fn has_non_file_read_reverse(&self, m: u32) -> bool {
        self.reverse(m).iter().any(|edge_id| {
            self.imports
                .get(*edge_id as usize)
                .is_some_and(|edge| !self.is_file_read_edge(edge))
        })
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
}

pub(super) fn file_read_dir_prefixes(path: &str) -> Vec<String> {
    let mut dirs = Vec::new();
    for (idx, byte) in path.bytes().enumerate() {
        if byte == b'/' && idx > 0 {
            dirs.push(path[..=idx].to_owned());
        }
    }
    dirs
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
