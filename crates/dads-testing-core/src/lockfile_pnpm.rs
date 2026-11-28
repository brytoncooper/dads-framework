//! Fail-closed parser for `pnpm-lock.yaml` (lockfileVersion 9.x) producing the same
//! `PackageSnapshot` map used by `lockfile_impact.rs` for package-diff narrowing.
//!
//! Any unsupported lockfile version or change in global policy sections (`overrides`,
//! `patchedDependencies`, `settings`, `catalog`, `catalogs`) returns `None` so the caller
//! falls back conservatively.

use crate::lockfile_parse::PackageSnapshot;
use std::collections::{BTreeMap, BTreeSet};

const GLOBAL_POLICY_SECTIONS: &[&str] = &[
    "overrides:",
    "patchedDependencies:",
    "settings:",
    "catalog:",
    "catalogs:",
];

pub(crate) fn parse_pnpm_lockfile_v9_packages(
    base_raw: &str,
    head_raw: &str,
) -> Option<(
    BTreeMap<String, PackageSnapshot>,
    BTreeMap<String, PackageSnapshot>,
)> {
    if !is_pnpm_v9(base_raw) || !is_pnpm_v9(head_raw) {
        return None;
    }
    for section in GLOBAL_POLICY_SECTIONS {
        if extract_top_level_section(base_raw, section)
            != extract_top_level_section(head_raw, section)
        {
            return None;
        }
    }
    let base_map = parse_single_pnpm_v9(base_raw)?;
    let head_map = parse_single_pnpm_v9(head_raw)?;
    Some((base_map, head_map))
}

fn is_pnpm_v9(raw: &str) -> bool {
    raw.lines().take(20).any(|line| {
        let Some(rest) = line.strip_prefix("lockfileVersion:") else {
            return false;
        };
        let v = rest.trim().trim_matches('\'').trim_matches('"');
        v.starts_with("9.") || v == "9"
    })
}

fn extract_top_level_section<'a>(raw: &'a str, header: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut active = false;
    for line in raw.lines() {
        if !line.starts_with(' ') && !line.is_empty() && !line.starts_with('#') {
            active = line.trim_end() == header;
            if active {
                out.push(line);
            }
        } else if active {
            out.push(line);
        }
    }
    out
}

fn parse_single_pnpm_v9(raw: &str) -> Option<BTreeMap<String, PackageSnapshot>> {
    let mut map: BTreeMap<String, PackageSnapshot> = BTreeMap::new();
    let mut section = "";
    let mut current_key: Option<String> = None;
    let mut in_deps_block = false;

    for line in raw.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') {
            section = line.trim_end();
            current_key = None;
            in_deps_block = false;
            continue;
        }
        if section != "packages:" && section != "snapshots:" {
            continue;
        }
        let indent = line.bytes().take_while(|&b| b == b' ').count();
        let trimmed = line.trim();
        if indent == 2 && trimmed.ends_with(':') {
            let raw_key = unquote_yaml_key(trimmed.trim_end_matches(':'));
            let (name, version) = split_pnpm_pkg_key(&raw_key)?;
            let base_meta = if section == "snapshots:" {
                map.get(strip_peer_suffix(&raw_key)).cloned()
            } else {
                None
            };
            let entry = map
                .entry(raw_key.clone())
                .or_insert_with(|| PackageSnapshot {
                    name,
                    version: Some(version),
                    integrity: None,
                    resolved: None,
                    dev: false,
                    optional: false,
                    peer: false,
                    has_bin: false,
                    has_install_script: false,
                    deps: BTreeSet::new(),
                });
            if let Some(pkg_meta) = base_meta {
                entry.integrity = pkg_meta.integrity;
                entry.has_bin = pkg_meta.has_bin;
                entry.has_install_script = pkg_meta.has_install_script;
            }
            current_key = Some(raw_key);
            in_deps_block = false;
            continue;
        }
        let Some(ref key) = current_key else {
            continue;
        };
        if indent == 4 {
            in_deps_block = matches!(
                trimmed,
                "dependencies:" | "optionalDependencies:" | "peerDependencies:"
            );
            if let Some(entry) = map.get_mut(key) {
                if let Some(rest) = trimmed.strip_prefix("resolution:") {
                    entry.integrity = Some(rest.trim().to_owned());
                } else if trimmed == "hasBin: true" {
                    entry.has_bin = true;
                } else if trimmed == "requiresBuild: true" || trimmed == "hasInstallScript: true" {
                    entry.has_install_script = true;
                }
            }
        } else if indent == 6 && in_deps_block {
            if let Some((dep_key, _)) = trimmed.split_once(':')
                && let Some(entry) = map.get_mut(key)
            {
                let dep_name = unquote_yaml_key(dep_key.trim());
                if !dep_name.is_empty() {
                    entry.deps.insert(dep_name);
                }
            }
        }
    }
    if map.is_empty() {
        return None;
    }
    Some(map)
}

fn unquote_yaml_key(raw: &str) -> String {
    let s = raw.trim();
    if (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
        || (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
    {
        return s[1..s.len() - 1].to_owned();
    }
    s.to_owned()
}

fn strip_peer_suffix(key: &str) -> &str {
    key.split_once('(').map_or(key, |(base, _)| base)
}

fn split_pnpm_pkg_key(raw_key: &str) -> Option<(String, String)> {
    let base = strip_peer_suffix(raw_key);
    let search_start = if base.starts_with('@') { 1 } else { 0 };
    let at_rel = base[search_start..].find('@')?;
    let at_idx = search_start + at_rel;
    let name = &base[..at_idx];
    let version = &base[at_idx + 1..];
    if name.is_empty() || version.is_empty() {
        return None;
    }
    Some((name.to_owned(), version.to_owned()))
}
