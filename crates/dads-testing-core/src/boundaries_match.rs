//! Pattern matching, path normalization, Node builtin detection, and cycle-graph reachability
//! helpers for native module-boundary enforcement.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub(crate) const IGNORED_SPECIFIER_PREFIXES: &[&str] = &["virtual:", "data:", "http:", "https:"];

const NODE_BUILTINS: &[&str] = &[
    "_http_agent",
    "_http_client",
    "_http_common",
    "_http_incoming",
    "_http_outgoing",
    "_http_server",
    "_stream_duplex",
    "_stream_passthrough",
    "_stream_readable",
    "_stream_transform",
    "_stream_wrap",
    "_stream_writable",
    "_tls_common",
    "_tls_wrap",
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "sqlite",
    "stream",
    "string_decoder",
    "sys",
    "test",
    "timers",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib",
];

pub(crate) fn has_package_subpath(specifier: &str) -> bool {
    if let Some(rest) = specifier.strip_prefix('@') {
        rest.split('/').count() > 2
    } else {
        specifier.contains('/')
    }
}

pub(crate) fn bfs_reaches(
    graph: &BTreeMap<String, BTreeSet<String>>,
    from: &str,
    to: &str,
) -> bool {
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::new();
    visited.insert(from);
    queue.push_back(from);
    while let Some(current) = queue.pop_front() {
        if let Some(neighbors) = graph.get(current) {
            for next in neighbors {
                if next == to {
                    return true;
                }
                if visited.insert(next.as_str()) {
                    queue.push_back(next.as_str());
                }
            }
        }
    }
    false
}

pub(crate) fn matches_allow(specifier: &str, allow_list: &[String]) -> bool {
    allow_list.iter().any(|pattern| {
        if let Some(prefix) = pattern.strip_suffix('*') {
            specifier.starts_with(prefix)
        } else {
            specifier == pattern
        }
    })
}

pub(crate) fn matches_any_tag(project_tags: &[String], target_tags: &[String]) -> bool {
    target_tags.iter().any(|tag| tag == "*")
        || target_tags
            .iter()
            .any(|tag| project_tags.iter().any(|pt| pt == tag))
}

pub(crate) fn matches_external_pattern(specifier: &str, pkg_name: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return specifier.starts_with(prefix) || pkg_name.starts_with(prefix);
    }
    specifier == pattern
        || specifier
            .strip_prefix(pattern)
            .is_some_and(|rest| rest.starts_with('/'))
        || pkg_name == pattern
}

pub(crate) fn extract_package_name(specifier: &str) -> &str {
    let clean = specifier.split('?').next().unwrap_or(specifier);
    if let Some(rest) = clean.strip_prefix('@')
        && let Some(first_slash) = rest.find('/')
    {
        let after_scope = &rest[first_slash + 1..];
        return match after_scope.find('/') {
            Some(second_slash) => &clean[..1 + first_slash + 1 + second_slash],
            None => clean,
        };
    }
    match clean.find('/') {
        Some(slash) => &clean[..slash],
        None => clean,
    }
}

pub(crate) fn is_node_builtin(name: &str) -> bool {
    NODE_BUILTINS.binary_search(&name).is_ok()
}

pub(crate) fn normalize_relative_posix(from_file: &str, specifier: &str) -> String {
    let dir = match from_file.rsplit_once('/') {
        Some((parent, _)) => parent,
        None => "",
    };
    let mut parts: Vec<&str> = if dir.is_empty() {
        Vec::new()
    } else {
        dir.split('/').collect()
    };
    for segment in specifier.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

pub(crate) fn format_quoted_list(items: &[String]) -> String {
    items
        .iter()
        .map(|item| format!("\"{item}\""))
        .collect::<Vec<_>>()
        .join(", ")
}
