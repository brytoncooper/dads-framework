//! Turning a module specifier into a workspace-relative path. Everything outside the workspace,
//! and everything that cannot be resolved, becomes an uncertainty located at the specifier itself.

use crate::facts::{JsSpan, JsUncertainty};
use crate::file_discovery::WorkspaceFileIndex;
use crate::workspace::{is_javascript_path, workspace_relative_path};
use oxc_resolver::Resolver;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ResolvedSpecifier {
    JavaScript(String),
    Asset(String),
}

pub(crate) struct ResolveContext<'a> {
    pub(crate) workspace_root: &'a Path,
    pub(crate) absolute_path: &'a Path,
    pub(crate) path: &'a str,
    pub(crate) resolver: &'a Resolver,
    pub(crate) workspace_index: &'a WorkspaceFileIndex,
}

/// Every resolution uncertainty is located at the specifier that could not be resolved, so a plan
/// can point at the import instead of the file.
pub(crate) fn resolve_static_specifier(
    ctx: &ResolveContext<'_>,
    specifier: &str,
    span: JsSpan,
    uncertainties: &mut Vec<JsUncertainty>,
) -> Option<ResolvedSpecifier> {
    if specifier.starts_with("virtual:") || specifier.starts_with('\0') {
        uncertainties.push(JsUncertainty {
            path: ctx.path.to_owned(),
            code: "generated-or-virtual-module".to_owned(),
            message: format!("{specifier} is a generated or virtual module."),
            span: Some(span),
            position: None,
        });
        return None;
    }
    match ctx.resolver.resolve_file(ctx.absolute_path, specifier) {
        Ok(resolution) => canonical_workspace_path(ctx.workspace_root, resolution.path()),
        Err(error) if is_local_specifier(specifier) => {
            resolve_local_javascript_specifier_to_typescript_source(
                ctx.workspace_root,
                ctx.absolute_path,
                specifier,
            )
            .map(ResolvedSpecifier::JavaScript)
            .or_else(|| {
                uncertainties.push(JsUncertainty {
                    path: ctx.path.to_owned(),
                    code: "unresolved-local-module".to_owned(),
                    message: format!("Could not resolve {specifier}: {error}"),
                    span: Some(span),
                    position: None,
                });
                None
            })
        }
        Err(_) if specifier.starts_with("node:") => None,
        Err(error) if is_bare_specifier(specifier) => {
            if let Some(types_specifier) = at_types_specifier(specifier)
                && let Ok(resolution) = ctx.resolver.resolve_file(ctx.absolute_path, &types_specifier)
            {
                return canonical_workspace_path(ctx.workspace_root, resolution.path());
            }
            if ctx.workspace_index.is_known_external_specifier(specifier) {
                return None;
            }
            uncertainties.push(JsUncertainty {
                path: ctx.path.to_owned(),
                code: "unresolved-bare-module".to_owned(),
                message: format!("Could not resolve bare module {specifier}: {error}"),
                span: Some(span),
                position: None,
            });
            None
        }
        Err(error) => {
            uncertainties.push(JsUncertainty {
                path: ctx.path.to_owned(),
                code: "unresolved-module-scheme".to_owned(),
                message: format!("Could not resolve module specifier {specifier}: {error}"),
                span: Some(span),
                position: None,
            });
            None
        }
    }
}

fn canonical_workspace_path(workspace_root: &Path, path: &Path) -> Option<ResolvedSpecifier> {
    let canonical_workspace_root = workspace_root.canonicalize().ok()?;
    let canonical_path = path.canonicalize().ok()?;
    if !canonical_path.starts_with(&canonical_workspace_root) || !canonical_path.is_file() {
        return None;
    }
    let rel = workspace_relative_path(&canonical_workspace_root, &canonical_path)?;
    if rel
        .split('/')
        .any(|segment| matches!(segment, "node_modules" | ".git"))
    {
        return None;
    }
    if is_javascript_path(&canonical_path) {
        Some(ResolvedSpecifier::JavaScript(rel))
    } else {
        Some(ResolvedSpecifier::Asset(rel))
    }
}

/// TypeScript commonly preserves `.js`/`.mjs`/`.cjs` specifiers in source that is emitted as
/// JavaScript. Oxc resolves real JavaScript first; only after that fails do we map the final
/// extension to an existing TypeScript sibling. This is deliberately not general extension inference.
fn resolve_local_javascript_specifier_to_typescript_source(
    workspace_root: &Path,
    absolute_path: &Path,
    specifier: &str,
) -> Option<String> {
    let requested_path = Path::new(specifier);
    let extensions: &[&str] = match requested_path
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some("js") => &["ts", "tsx", "mts", "cts"],
        Some("mjs") => &["mts"],
        Some("cjs") => &["cts"],
        _ => return None,
    };
    let canonical_workspace_root = workspace_root.canonicalize().ok()?;
    let requested_path = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        absolute_path.parent()?.join(requested_path)
    };
    for extension in extensions {
        let candidate = requested_path.with_extension(extension);
        let canonical_candidate = candidate.canonicalize().ok();
        if candidate.is_file()
            && canonical_candidate.as_ref().is_some_and(|candidate| {
                is_javascript_path(candidate) && candidate.starts_with(&canonical_workspace_root)
            })
        {
            return canonical_candidate.as_deref().and_then(|candidate| {
                workspace_relative_path(&canonical_workspace_root, candidate)
            });
        }
    }
    None
}

fn at_types_specifier(specifier: &str) -> Option<String> {
    if specifier.starts_with("@types/") {
        return None;
    }
    if let Some(rest) = specifier.strip_prefix('@') {
        let (scope, tail) = rest.split_once('/')?;
        return Some(match tail.split_once('/') {
            Some((pkg, sub)) => format!("@types/{scope}__{pkg}/{sub}"),
            None => format!("@types/{scope}__{tail}"),
        });
    }
    Some(format!("@types/{specifier}"))
}

fn is_local_specifier(specifier: &str) -> bool {
    specifier == "."
        || specifier == ".."
        || specifier.starts_with("./")
        || specifier.starts_with("../")
        || specifier.starts_with('/')
}

fn is_bare_specifier(specifier: &str) -> bool {
    !is_local_specifier(specifier) && !specifier.contains(':')
}
