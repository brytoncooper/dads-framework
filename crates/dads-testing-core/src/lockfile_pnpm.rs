//! Fail-closed parser and exact snapshot-key differ for `pnpm-lock.yaml` (lockfileVersion 9.x).
//!
//! Any unsupported lockfile version or change in global policy sections (`overrides`,
//! `patchedDependencies`, `settings`, `catalog`, `catalogs`) returns `None` so the caller
//! falls back conservatively.

use crate::lockfile_parse::{PackageSnapshot, is_toolchain_package};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const GLOBAL_POLICY_SECTIONS: &[&str] = &[
    "overrides:",
    "patchedDependencies:",
    "settings:",
    "catalog:",
    "catalogs:",
];

pub(crate) struct PnpmLockfileV9 {
    pub(crate) packages: BTreeMap<String, PackageSnapshot>,
    pub(crate) importers: BTreeMap<String, BTreeSet<String>>,
}

pub(crate) struct PnpmDiffOutcome {
    pub(crate) impacted_packages: BTreeSet<String>,
    pub(crate) scoped_importer_dirs: Option<BTreeSet<String>>,
    pub(crate) widened_importer_dirs: BTreeSet<String>,
    pub(crate) newly_added_only: bool,
    pub(crate) must_widen: bool,
    pub(crate) widen_reason: Option<String>,
}

pub(crate) fn diff_pnpm_lockfile_v9(base_raw: &str, head_raw: &str) -> Option<PnpmDiffOutcome> {
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
    let base = parse_single_pnpm_v9(base_raw)?;
    let head = parse_single_pnpm_v9(head_raw)?;
    Some(compute_snapshot_diff(&base, &head))
}

fn compute_snapshot_diff(base: &PnpmLockfileV9, head: &PnpmLockfileV9) -> PnpmDiffOutcome {
    let (direct_changed, existing_changed_or_removed, newly_added_only) =
        collect_direct_snapshot_changes(base, head);
    let closure_keys = compute_snapshot_closure(base, head, &direct_changed);

    let base_names: BTreeSet<&str> = base.packages.values().map(|e| e.name.as_str()).collect();
    let mut impacted_packages = BTreeSet::new();
    let mut trigger_reason: Option<String> = None;
    for key in &closure_keys {
        if let Some(entry) = head.packages.get(key).or_else(|| base.packages.get(key)) {
            impacted_packages.insert(entry.name.clone());
            if trigger_reason.is_none() {
                if is_toolchain_package(&entry.name) {
                    trigger_reason = Some(format!(
                        "pnpm-lock.yaml impacted toolchain package {}; widening affected tasks.",
                        entry.name
                    ));
                } else if (entry.has_bin || entry.has_install_script)
                    && base_names.contains(entry.name.as_str())
                    && existing_changed_or_removed.contains(key)
                {
                    trigger_reason = Some(format!(
                        "pnpm-lock.yaml changed existing package {} with bin/install script; widening affected tasks.",
                        entry.name
                    ));
                }
            }
        }
    }

    let affected_importers = collect_affected_importers(base, head, &closure_keys);
    let non_root_only = !affected_importers.is_empty()
        && !affected_importers.contains(".")
        && !affected_importers.contains("");

    if let Some(reason) = trigger_reason {
        if non_root_only {
            return PnpmDiffOutcome {
                impacted_packages,
                scoped_importer_dirs: Some(affected_importers.clone()),
                widened_importer_dirs: affected_importers,
                newly_added_only: false,
                must_widen: false,
                widen_reason: None,
            };
        }
        return PnpmDiffOutcome {
            impacted_packages,
            scoped_importer_dirs: None,
            widened_importer_dirs: BTreeSet::new(),
            newly_added_only: false,
            must_widen: true,
            widen_reason: Some(reason),
        };
    }

    PnpmDiffOutcome {
        impacted_packages,
        scoped_importer_dirs: non_root_only.then_some(affected_importers),
        widened_importer_dirs: BTreeSet::new(),
        newly_added_only: newly_added_only && !direct_changed.is_empty(),
        must_widen: false,
        widen_reason: None,
    }
}

fn collect_direct_snapshot_changes(
    base: &PnpmLockfileV9,
    head: &PnpmLockfileV9,
) -> (BTreeSet<String>, BTreeSet<String>, bool) {
    let mut direct_changed = BTreeSet::new();
    let mut existing_changed_or_removed = BTreeSet::new();
    let mut newly_added_only = true;
    for (key, head_entry) in &head.packages {
        match base.packages.get(key) {
            None => {
                direct_changed.insert(key.clone());
            }
            Some(base_entry) if base_entry != head_entry => {
                direct_changed.insert(key.clone());
                existing_changed_or_removed.insert(key.clone());
                newly_added_only = false;
            }
            _ => {}
        }
    }
    for key in base.packages.keys() {
        if !head.packages.contains_key(key) {
            direct_changed.insert(key.clone());
            existing_changed_or_removed.insert(key.clone());
            newly_added_only = false;
        }
    }
    (
        direct_changed,
        existing_changed_or_removed,
        newly_added_only,
    )
}

fn compute_snapshot_closure(
    base: &PnpmLockfileV9,
    head: &PnpmLockfileV9,
    direct_changed: &BTreeSet<String>,
) -> BTreeSet<String> {
    let mut reverse_deps: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (snap_key, entry) in base.packages.iter().chain(head.packages.iter()) {
        for dep_key in &entry.deps {
            reverse_deps
                .entry(dep_key.clone())
                .or_default()
                .insert(snap_key.clone());
        }
    }
    let mut closure_keys = BTreeSet::new();
    let mut queue = VecDeque::new();
    for key in direct_changed {
        if closure_keys.insert(key.clone()) {
            queue.push_back(key.clone());
        }
    }
    while let Some(current) = queue.pop_front() {
        if let Some(parents) = reverse_deps.get(&current) {
            for parent in parents {
                if closure_keys.insert(parent.clone()) {
                    queue.push_back(parent.clone());
                }
            }
        }
    }
    closure_keys
}

fn collect_affected_importers(
    base: &PnpmLockfileV9,
    head: &PnpmLockfileV9,
    closure_keys: &BTreeSet<String>,
) -> BTreeSet<String> {
    let mut affected = BTreeSet::new();
    for dir in base.importers.keys().chain(head.importers.keys()) {
        let base_deps = base.importers.get(dir);
        let head_deps = head.importers.get(dir);
        let changed_direct = base_deps != head_deps;
        let touches_closure = base_deps
            .into_iter()
            .chain(head_deps)
            .flatten()
            .any(|dep_key| closure_keys.contains(dep_key));
        if changed_direct || touches_closure {
            affected.insert(dir.clone());
        }
    }
    affected
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

fn parse_single_pnpm_v9(raw: &str) -> Option<PnpmLockfileV9> {
    let mut map: BTreeMap<String, PackageSnapshot> = BTreeMap::new();
    let mut importers: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut section = "";
    let mut current_key: Option<String> = None;
    let mut current_dep: Option<String> = None;
    let mut in_deps_block = false;

    for line in raw.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') {
            section = line.trim_end();
            current_key = None;
            current_dep = None;
            in_deps_block = false;
            continue;
        }
        let indent = line.bytes().take_while(|&b| b == b' ').count();
        let trimmed = line.trim();
        if section == "importers:" {
            parse_importer_line(
                indent,
                trimmed,
                &mut importers,
                &mut current_key,
                &mut current_dep,
                &mut in_deps_block,
            );
            continue;
        }
        if section != "packages:" && section != "snapshots:" {
            continue;
        }
        parse_package_or_snapshot_line(
            section,
            indent,
            trimmed,
            &mut map,
            &mut current_key,
            &mut in_deps_block,
        )?;
    }
    if map.is_empty() {
        return None;
    }
    Some(PnpmLockfileV9 {
        packages: map,
        importers,
    })
}

fn parse_package_or_snapshot_line(
    section: &str,
    indent: usize,
    trimmed: &str,
    map: &mut BTreeMap<String, PackageSnapshot>,
    current_key: &mut Option<String>,
    in_deps_block: &mut bool,
) -> Option<()> {
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
        *current_key = Some(raw_key);
        *in_deps_block = false;
        return Some(());
    }
    let Some(ref key) = *current_key else {
        return Some(());
    };
    if indent == 4 {
        *in_deps_block = matches!(
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
    } else if indent == 6
        && *in_deps_block
        && section == "snapshots:"
        && let Some((dep_key, dep_val)) = trimmed.split_once(':')
        && let Some(entry) = map.get_mut(key)
        && let Some(snap_dep) =
            format_dep_snapshot_key(&unquote_yaml_key(dep_key), &unquote_yaml_key(dep_val))
    {
        entry.deps.insert(snap_dep);
    }
    Some(())
}

fn parse_importer_line(
    indent: usize,
    trimmed: &str,
    importers: &mut BTreeMap<String, BTreeSet<String>>,
    current_key: &mut Option<String>,
    current_dep: &mut Option<String>,
    in_deps_block: &mut bool,
) {
    if indent == 2 && trimmed.ends_with(':') {
        let dir = unquote_yaml_key(trimmed.trim_end_matches(':'));
        importers.entry(dir.clone()).or_default();
        *current_key = Some(dir);
        *current_dep = None;
        *in_deps_block = false;
    } else if indent == 4 {
        *in_deps_block = matches!(
            trimmed,
            "dependencies:" | "devDependencies:" | "optionalDependencies:" | "peerDependencies:"
        );
        *current_dep = None;
    } else if indent == 6 && *in_deps_block && trimmed.ends_with(':') {
        *current_dep = Some(unquote_yaml_key(trimmed.trim_end_matches(':')));
    } else if indent == 8
        && *in_deps_block
        && let Some(rest) = trimmed.strip_prefix("version:")
        && let Some(dir) = current_key.as_ref()
        && let Some(dep_name) = current_dep.as_ref()
        && let Some(deps) = importers.get_mut(dir)
        && let Some(snap_key) = format_dep_snapshot_key(dep_name, &unquote_yaml_key(rest))
    {
        deps.insert(snap_key);
    }
}

fn format_dep_snapshot_key(dep_name: &str, dep_version: &str) -> Option<String> {
    if dep_name.is_empty() || dep_version.is_empty() || dep_version.starts_with("link:") {
        return None;
    }
    if dep_version.starts_with('@')
        || (!dep_version.starts_with(|c: char| c.is_ascii_digit() || c == '(')
            && dep_version.contains('@'))
    {
        return Some(dep_version.to_owned());
    }
    Some(format!("{dep_name}@{dep_version}"))
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
