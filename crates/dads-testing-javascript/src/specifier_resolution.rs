//! Turning a module specifier into a workspace-relative path. Everything outside the workspace,
//! and everything that cannot be resolved, becomes an uncertainty located at the specifier itself.

use crate::facts::{JsSpan, JsUncertainty};
use crate::workspace::{is_javascript_path, workspace_relative_path};
use oxc_resolver::Resolver;
use std::path::Path;

/// Every resolution uncertainty is located at the specifier that could not be resolved, so a plan
/// can point at the import instead of the file.
pub(crate) fn resolve_static_specifier(
    workspace_root: &Path,
    absolute_path: &Path,
    path: &str,
    resolver: &Resolver,
    specifier: &str,
    span: JsSpan,
    uncertainties: &mut Vec<JsUncertainty>,
) -> Option<String> {
    if specifier.starts_with("virtual:") || specifier.starts_with('\0') {
        uncertainties.push(JsUncertainty {
            path: path.to_owned(),
            code: "generated-or-virtual-module".to_owned(),
            message: format!("{specifier} is a generated or virtual module."),
            span: Some(span),
            position: None,
        });
        return None;
    }
    match resolver.resolve_file(absolute_path, specifier) {
        Ok(resolution) => {
            let resolved = resolution.path();
            canonical_workspace_javascript_path(workspace_root, resolved)
        }
        Err(error) if is_local_specifier(specifier) => {
            resolve_local_javascript_specifier_to_typescript_source(
                workspace_root,
                absolute_path,
                specifier,
            )
            .or_else(|| {
                uncertainties.push(JsUncertainty {
                    path: path.to_owned(),
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
            uncertainties.push(JsUncertainty {
                path: path.to_owned(),
                code: "unresolved-bare-module".to_owned(),
                message: format!("Could not resolve bare module {specifier}: {error}"),
                span: Some(span),
                position: None,
            });
            None
        }
        Err(error) => {
            uncertainties.push(JsUncertainty {
                path: path.to_owned(),
                code: "unresolved-module-scheme".to_owned(),
                message: format!("Could not resolve module specifier {specifier}: {error}"),
                span: Some(span),
                position: None,
            });
            None
        }
    }
}

fn canonical_workspace_javascript_path(workspace_root: &Path, path: &Path) -> Option<String> {
    let canonical_workspace_root = workspace_root.canonicalize().ok()?;
    let canonical_path = path.canonicalize().ok()?;
    if !is_javascript_path(&canonical_path)
        || !canonical_path.starts_with(&canonical_workspace_root)
    {
        return None;
    }
    workspace_relative_path(&canonical_workspace_root, &canonical_path)
}

/// TypeScript commonly preserves `.js` specifiers in source that is emitted as JavaScript. Oxc
/// resolves real JavaScript first; only after that fails do we map the final `.js` extension to an
/// existing source sibling. This is deliberately not general extension inference.
fn resolve_local_javascript_specifier_to_typescript_source(
    workspace_root: &Path,
    absolute_path: &Path,
    specifier: &str,
) -> Option<String> {
    let requested_path = Path::new(specifier);
    if requested_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("js")
    {
        return None;
    }
    let canonical_workspace_root = workspace_root.canonicalize().ok()?;
    let requested_path = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        absolute_path.parent()?.join(requested_path)
    };
    for extension in ["ts", "tsx", "mts", "cts"] {
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
