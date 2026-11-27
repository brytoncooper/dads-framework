//! The entry point one request travels through: validate it, load the manifest, resolve the
//! scope, plan, and — for a run operation — schedule. Every rejection leaves as a typed error.
use crate::boundaries::check_boundaries;
use crate::boundaries_config::{load_boundaries_config, validate_workspace_boundaries};
use crate::diagnose::build_diagnose;
use crate::discover::expand_manifest;
use crate::graph::DependencyGraph;
use crate::hotspots::build_hotspots;
use crate::manifest::{DEFAULT_MANIFEST_PATH, TestingManifest, load_manifest, validate_manifest};
use crate::plan::{PlanFilters, build_plan};
use crate::plan_file::{load_plan_file, plan_file_missing_read_guard_allowlists};
use crate::protocol::{
    NativeRequest, NativeResponse, Operation, OperationResult, PROTOCOL_SCHEMA_VERSION, PlanCounts,
    PlanResult, ReadGuardMode, ResolvedScope,
};
use crate::receipts::TaskReceiptStore;
use crate::scheduler;
use crate::scope::{absolute_existing_directory, resolve_existing_inside, resolve_scope};
use std::collections::BTreeSet;
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

/// Whether a `run` request enables runtime read guarding (audit or enforce via CLI or manifest).
pub fn request_uses_read_guard(request: &NativeRequest) -> bool {
    if request.operation != Operation::Run {
        return false;
    }
    if request.audit_reads {
        return true;
    }
    if request.no_enforce_declared_reads {
        return false;
    }
    request.enforce_declared_reads
        || load_declared_manifest(request)
            .map(|(_, _, manifest)| manifest.workspace.enforce_declared_reads)
            .unwrap_or(false)
}

/// Whether a `--plan-file` run with active read guarding needs the dependency graph loaded because
/// at least one runnable guarded task lacks a planner-computed `readGuardAllowlist`.
pub fn plan_file_needs_graph_for_read_guard(request: &NativeRequest) -> bool {
    let Some(plan_file) = request.plan_file.as_deref() else {
        return false;
    };
    if !request_uses_read_guard(request) {
        return false;
    }
    let Ok((workspace_root, _, manifest)) = load_declared_manifest(request) else {
        return false;
    };
    let effective_enforce = !request.no_enforce_declared_reads
        && (request.enforce_declared_reads || manifest.workspace.enforce_declared_reads);
    let filters = PlanFilters {
        task_kinds: &request.task_kinds,
        targets: &request.targets,
        projects: &request.projects,
        exclude_projects: &request.exclude_projects,
        shard: request.shard,
        shard_weights: &request.shard_weights,
        enforce_declared_reads: effective_enforce,
    };
    plan_file_missing_read_guard_allowlists(&workspace_root, plan_file, &manifest, &filters)
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

/// Returns the declared `workspace.ignorePaths` patterns from the workspace's manifest so a
/// language frontend excludes ignored files from discovery and graph construction.
pub fn manifest_ignore_paths(request: &NativeRequest) -> Vec<String> {
    load_declared_manifest(request)
        .map(|(_, _, manifest)| manifest.workspace.ignore_paths)
        .unwrap_or_default()
}

/// Returns the declared `workspace.pureFactories` patterns from the default workspace manifest
/// (or empty when no default manifest exists or cannot be read).
pub fn manifest_pure_factories_from_root(workspace_root: &Path) -> Vec<String> {
    let manifest_file = workspace_root.join(DEFAULT_MANIFEST_PATH);
    load_manifest(&manifest_file)
        .map(|manifest| manifest.workspace.pure_factories)
        .unwrap_or_default()
}

/// Returns the canonical serialized expanded manifest bytes when the manifest uses declarative
/// `workspace.discover`, or `None` when it is static (callers hash raw manifest bytes instead).
pub fn expanded_manifest_bytes(
    workspace_root: &Path,
    manifest_path: Option<&str>,
) -> Option<Vec<u8>> {
    let manifest_rel = manifest_path.unwrap_or(DEFAULT_MANIFEST_PATH);
    let manifest_file =
        resolve_existing_inside(workspace_root, Path::new(manifest_rel), "manifestPath").ok()?;
    let raw = load_manifest(&manifest_file).ok()?;
    raw.workspace.discover.as_ref()?;
    let expanded = expand_manifest(raw, workspace_root).ok()?;
    serde_json::to_vec(&expanded).ok()
}

fn validate_request(request: &NativeRequest) -> Result<(), TestingError> {
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
    if request.all && !request.task_ids.is_empty() {
        return Err(message(
            "--all cannot be combined with --task. Use --only --task <id> to run only the requested tasks and their prerequisites.",
        ));
    }
    if request.only {
        if request.all || request.base.is_some() || request.head.is_some() {
            return Err(message(
                "--only cannot be combined with --all, --base, or --head.",
            ));
        }
        if request.task_ids.is_empty()
            && request.projects.is_empty()
            && request.targets.is_empty()
            && request.task_kinds.is_empty()
        {
            return Err(message(
                "--only requires at least one --task, --project, --target, or --kind selector.",
            ));
        }
    }
    if request.plan_file.is_some() {
        if request.operation != Operation::Run {
            return Err(message(
                "--plan-file is only supported for the run operation.",
            ));
        }
        if request.all
            || request.only
            || request.base.is_some()
            || request.head.is_some()
            || !request.task_ids.is_empty()
        {
            return Err(message(
                "--plan-file cannot be combined with --all, --only, --base, --head, or --task.",
            ));
        }
    }
    Ok(())
}

fn execute(
    request: NativeRequest,
    graph: Option<&DependencyGraph>,
    receipts: Option<&dyn TaskReceiptStore>,
) -> Result<OperationResult, TestingError> {
    validate_request(&request)?;
    if request.operation == Operation::CheckBoundaries {
        return execute_check_boundaries(&request, graph);
    }
    let (workspace_root, manifest_file, manifest) = load_declared_manifest(&request)?;
    validate_manifest(&manifest, &workspace_root)?;
    match request.operation {
        Operation::ExpandManifest => {
            let serialized = serde_json::to_value(&manifest).map_err(|error| {
                message(format!("Unable to serialize expanded manifest: {error}"))
            })?;
            let mut result = result_for("expand-manifest", empty_plan_for("expand-manifest"));
            result.manifest = Some(serialized);
            Ok(result)
        }
        Operation::Diagnose => {
            let mut result = result_for("diagnose", empty_plan_for("diagnose"));
            result.diagnose = Some(build_diagnose(&manifest, &workspace_root, graph));
            Ok(result)
        }
        Operation::Hotspots => {
            let mut result = result_for("hotspots", empty_plan_for("hotspots"));
            result.hotspots = Some(build_hotspots(&manifest, graph, request.hotspots.as_ref()));
            Ok(result)
        }
        Operation::CheckBoundaries => execute_check_boundaries(&request, graph),
        Operation::Plan | Operation::Run => execute_plan_or_run(
            request,
            &workspace_root,
            &manifest_file,
            &manifest,
            graph,
            receipts,
        ),
    }
}

fn execute_plan_or_run(
    request: NativeRequest,
    workspace_root: &Path,
    manifest_file: &Path,
    manifest: &TestingManifest,
    graph: Option<&DependencyGraph>,
    receipts: Option<&dyn TaskReceiptStore>,
) -> Result<OperationResult, TestingError> {
    let effective_enforce = !request.no_enforce_declared_reads
        && (request.enforce_declared_reads || manifest.workspace.enforce_declared_reads);
    let filters = PlanFilters {
        task_kinds: &request.task_kinds,
        targets: &request.targets,
        projects: &request.projects,
        exclude_projects: &request.exclude_projects,
        shard: request.shard,
        shard_weights: &request.shard_weights,
        enforce_declared_reads: effective_enforce,
    };
    let plan = if let Some(plan_file) = request.plan_file.as_deref() {
        load_plan_file(workspace_root, plan_file, manifest, &filters, request.jobs)?
    } else {
        let scope = resolve_scope(&request, workspace_root)?;
        build_plan(
            manifest,
            workspace_root,
            &scope,
            &request.task_ids,
            &filters,
            request.jobs,
            graph,
        )?
    };
    if request.operation == Operation::Run {
        let read_guard_mode = if request.audit_reads {
            Some(ReadGuardMode::Audit)
        } else if effective_enforce {
            Some(ReadGuardMode::Enforce)
        } else {
            None
        };
        let run = scheduler::run_plan(
            manifest,
            workspace_root,
            manifest_file,
            &plan,
            scheduler::RunOptions {
                jobs: request.jobs,
                receipts: request.cache.then_some(receipts).flatten(),
                stream_enabled: request.stream,
                graph,
                read_guard_mode,
                read_guard_hook_path: request.read_guard_hook_path.as_deref(),
                workspace_root_raw: Path::new(&request.workspace_root),
            },
        )?;
        let mut result = result_for("run", plan);
        result.run = Some(run);
        return Ok(result);
    }
    Ok(result_for("plan", plan))
}

fn execute_check_boundaries(
    request: &NativeRequest,
    graph: Option<&DependencyGraph>,
) -> Result<OperationResult, TestingError> {
    let workspace_root = absolute_existing_directory(&request.workspace_root, "workspaceRoot")?;
    let manifest = load_optional_manifest_for_boundaries(request, &workspace_root)?;
    let config = match &request.boundaries_config_path {
        Some(config_path) => {
            let resolved = resolve_existing_inside(
                &workspace_root,
                Path::new(config_path),
                "boundariesConfigPath",
            )?;
            load_boundaries_config(&resolved)?
        }
        None => {
            let boundaries = manifest
                .as_ref()
                .and_then(|m| m.workspace.boundaries.clone())
                .ok_or_else(|| {
                    message(
                        "No boundaries configuration found. Declare workspace.boundaries in dads.testing.json or pass --config <path>.",
                    )
                })?;
            validate_workspace_boundaries(&boundaries)?;
            boundaries
        }
    };
    let changed_paths = if request.base.is_some() {
        let scope = resolve_scope(request, &workspace_root)?;
        if scope.full_fallback {
            None
        } else {
            Some(scope.changed_paths.into_iter().collect::<BTreeSet<_>>())
        }
    } else {
        None
    };
    let graph = graph.ok_or_else(|| {
        message("Boundary checking requires a JavaScript/TypeScript dependency graph.")
    })?;
    let result = check_boundaries(
        &workspace_root,
        manifest.as_ref().map(|m| m.projects.as_slice()),
        &config,
        graph,
        changed_paths.as_ref(),
    );
    let mut op = result_for("check-boundaries", empty_plan_for("check-boundaries"));
    op.boundaries = Some(result);
    Ok(op)
}

fn result_for(operation: &str, plan: PlanResult) -> OperationResult {
    OperationResult {
        operation: operation.into(),
        plan,
        run: None,
        diagnose: None,
        hotspots: None,
        manifest: None,
        boundaries: None,
    }
}

fn load_optional_manifest_for_boundaries(
    request: &NativeRequest,
    workspace_root: &Path,
) -> Result<Option<TestingManifest>, TestingError> {
    if request.manifest_path.is_some() || workspace_root.join(DEFAULT_MANIFEST_PATH).is_file() {
        let (_, _, manifest) = load_declared_manifest(request)?;
        validate_manifest(&manifest, workspace_root)?;
        return Ok(Some(manifest));
    }
    Ok(None)
}

fn empty_plan_for(kind: &str) -> PlanResult {
    PlanResult {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        scope: ResolvedScope {
            kind: kind.into(),
            base: None,
            head: None,
            changed_paths: Vec::new(),
            full_fallback: false,
        },
        tasks: Vec::new(),
        issues: Vec::new(),
        complete: true,
        counts: PlanCounts {
            run: 0,
            skip_proven_unaffected: 0,
        },
        shard: None,
        workspace_fingerprint: None,
    }
}

/// The workspace root a request names, the manifest file path, and the expanded manifest it declares.
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
    let manifest = expand_manifest(load_manifest(&manifest_file)?, &workspace_root)?;
    Ok((workspace_root, manifest_file, manifest))
}
