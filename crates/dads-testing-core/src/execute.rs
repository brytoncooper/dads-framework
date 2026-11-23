//! The entry point one request travels through: validate it, load the manifest, resolve the
//! scope, plan, and — for a run operation — schedule. Every rejection leaves as a typed error.
use crate::graph::DependencyGraph;
use crate::manifest::{DEFAULT_MANIFEST_PATH, TestingManifest, load_manifest, validate_manifest};
use crate::plan::build_plan;
use crate::protocol::{
    NativeRequest, NativeResponse, Operation, OperationResult, PROTOCOL_SCHEMA_VERSION,
};
use crate::receipts::TaskReceiptStore;
use crate::scheduler;
use crate::scope::{absolute_existing_directory, resolve_existing_inside, resolve_scope};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum TestingError {
    #[error("{0}")]
    Message(String),
    /// `--head` without `--base` is refused in `execute` before scope resolution runs, so scope
    /// resolution never sees this pair. The branch is still reachable to the compiler, and it
    /// answers with this error instead of panicking: an impossible request leaves through the
    /// protocol like every other rejection.
    #[error("--head requires --base.")]
    HeadWithoutBase,
}

pub(crate) fn message(value: impl Into<String>) -> TestingError {
    TestingError::Message(value.into())
}

pub fn execute_request(request: NativeRequest) -> NativeResponse {
    execute_request_with_graph(request, None)
}

/// Executes a protocol-v1 request using optional, language-specific impact evidence.
///
/// The core deliberately does not choose or import a language frontend. A caller that has no
/// trusted evidence widens through the manifest's declared project dependencies.
pub fn execute_request_with_graph(
    request: NativeRequest,
    graph: Option<DependencyGraph>,
) -> NativeResponse {
    execute_request_with_graph_and_receipts(request, graph, None)
}

/// Executes a protocol-v1 request with optional graph evidence and an optional opt-in content-
/// hashed task receipt store (used only when `request.cache` is `true`).
pub fn execute_request_with_graph_and_receipts(
    request: NativeRequest,
    graph: Option<DependencyGraph>,
    receipts: Option<&dyn TaskReceiptStore>,
) -> NativeResponse {
    match execute(request, graph.as_ref(), receipts) {
        Ok(result) => NativeResponse::success(result),
        Err(error) => NativeResponse::failure(error.to_string()),
    }
}

/// Whether analyzing this workspace's dependency graph could change the plan the request answers.
///
/// Building a graph means parsing the whole workspace, so a caller that owns a language frontend
/// asks this first and does the work only when the answer is yes. It is yes exactly when the
/// declared manifest has a `reachability` task: `always`, `changed-files`, and `project` impact
/// decide from the manifest and the changed paths alone, and pass a graph nothing ever reads.
///
/// A request whose manifest cannot even be located or parsed answers yes. That request is about
/// to be refused by `execute_request_with_graph` with the real reason, and answering no would let
/// an unreadable manifest quietly decide that no analysis was needed.
pub fn graph_analysis_can_change_the_plan(request: &NativeRequest) -> bool {
    load_declared_manifest(request)
        .map(|(_, _, manifest)| manifest.declares_graph_reader())
        .unwrap_or(true)
}

/// Returns the declared project roots from the workspace's manifest so a language frontend can
/// scope workspace indexing to declared projects rather than scanning unrelated scripts or fixtures.
pub fn manifest_project_roots(request: &NativeRequest) -> Option<Vec<String>> {
    let (_, _, manifest) = load_declared_manifest(request).ok()?;
    Some(
        manifest
            .projects
            .into_iter()
            .map(|project| project.root)
            .collect(),
    )
}

fn execute(
    request: NativeRequest,
    graph: Option<&DependencyGraph>,
    receipts: Option<&dyn TaskReceiptStore>,
) -> Result<OperationResult, TestingError> {
    if request.schema_version != PROTOCOL_SCHEMA_VERSION {
        return Err(message(format!(
            "Unsupported request schemaVersion {}. Expected 1.",
            request.schema_version
        )));
    }
    if request.head.is_some() && request.base.is_none() {
        return Err(TestingError::HeadWithoutBase);
    }
    if request.all && (request.base.is_some() || request.head.is_some()) {
        return Err(message("--all cannot be combined with --base or --head."));
    }
    let (workspace_root, manifest_file, manifest) = load_declared_manifest(&request)?;
    validate_manifest(&manifest, &workspace_root)?;
    let scope = resolve_scope(&request, &workspace_root)?;
    let plan = build_plan(
        &manifest,
        &workspace_root,
        &scope,
        &request.task_ids,
        request.jobs,
        graph,
    )?;
    match request.operation {
        Operation::Plan => Ok(OperationResult {
            operation: "plan".into(),
            plan,
            run: None,
        }),
        Operation::Run => {
            let active_receipts = if request.cache { receipts } else { None };
            let run = scheduler::run_plan(
                &manifest,
                &workspace_root,
                &manifest_file,
                &plan,
                request.jobs,
                active_receipts,
            )?;
            Ok(OperationResult {
                operation: "run".into(),
                plan,
                run: Some(run),
            })
        }
    }
}

/// The workspace root a request names, the manifest file path, and the manifest it declares.
fn load_declared_manifest(
    request: &NativeRequest,
) -> Result<(PathBuf, PathBuf, TestingManifest), TestingError> {
    let workspace_root = absolute_existing_directory(&request.workspace_root, "workspaceRoot")?;
    let manifest_path = request
        .manifest_path
        .as_deref()
        .unwrap_or(DEFAULT_MANIFEST_PATH);
    let manifest_file =
        resolve_existing_inside(&workspace_root, Path::new(manifest_path), "manifestPath")?;
    let manifest = load_manifest(&manifest_file)?;
    Ok((workspace_root, manifest_file, manifest))
}
