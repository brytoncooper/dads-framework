use dads_testing_core::graph::DependencyGraph;
use dads_testing_core::{
    IssueScope, IssueSeverity, NativeRequest, NativeResponse, Operation, PlanIssue,
    TaskReceiptStore, execute_request_with_graph_and_receipts, graph_analysis_can_change_the_plan,
    is_empty_tree_sha, manifest_project_roots, request_uses_read_guard,
};
use dads_testing_javascript::{JavaScriptFrontend, analyze_workspace_graph};
use dads_testing_store::{
    FileReceiptStore, StoreIssue, StoreIssueSeverity, load_or_update, resolve_cache_dir,
};
use std::io::{self, Read};
use std::path::Path;

fn main() {
    let mut input = String::new();
    if let Err(error) = io::stdin().read_to_string(&mut input) {
        print_response(NativeResponse::failure(format!(
            "Unable to read request: {error}"
        )));
        std::process::exit(1);
    }

    let response = match serde_json::from_str::<NativeRequest>(&input) {
        Ok(request) => answer(request),
        Err(error) => NativeResponse::failure(format!("Invalid JSON request: {error}")),
    };
    let succeeded = response.ok;
    print_response(response);
    if !succeeded {
        std::process::exit(1);
    }
}

/// The graph a plan is given, and what to report about how it was reached.
struct GraphAnalysis {
    graph: Option<DependencyGraph>,
    issues: Vec<PlanIssue>,
}

fn answer(request: NativeRequest) -> NativeResponse {
    let analysis = analyze_workspace(&request);
    let receipt_store = build_receipt_store(&request);
    let receipts: Option<&dyn TaskReceiptStore> = receipt_store
        .as_ref()
        .map(|store| store as &dyn TaskReceiptStore);
    let mut response = execute_request_with_graph_and_receipts(request, analysis.graph, receipts);
    if let Some(result) = &mut response.result {
        // Analysis issues are appended after the core's own issues. A decision cites an issue by
        // its position in this emitted list, so this order is part of the plan contract: core
        // issues keep the indexes the planner assigned them.
        result.plan.issues.extend(analysis.issues);
    }
    response
}

fn build_receipt_store(request: &NativeRequest) -> Option<FileReceiptStore> {
    if !request.cache {
        return None;
    }
    let remote_url = request.remote_cache_url.clone().or_else(|| {
        std::env::var("DADS_TESTING_REMOTE_CACHE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
    });
    let remote_token = std::env::var("DADS_TESTING_REMOTE_CACHE_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let explicit_cache_dir = request
        .cache_dir
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("DAD_TEST_CACHE_DIR")
                .ok()
                .filter(|value| !value.trim().is_empty())
        });
    let workspace_root = Path::new(&request.workspace_root);
    let base_store = match explicit_cache_dir {
        Some(raw) => {
            resolve_cache_dir(&raw, workspace_root).map(|dir| FileReceiptStore::for_cache_dir(&dir))
        }
        None => FileReceiptStore::for_workspace(workspace_root),
    };
    base_store.map(|store| match remote_url {
        Some(url) => store.with_remote_url(&url, remote_token),
        None => store,
    })
}

/// Analyzing the workspace means parsing every module in it, so it happens only when a declared
/// task could read the result. A manifest whose tasks all decide from the changed paths alone
/// plans identically with no graph, and skipping the analysis leaves the snapshot store untouched:
/// nothing is read, nothing is rebuilt, and nothing is written.
fn analyze_workspace(request: &NativeRequest) -> GraphAnalysis {
    if request.operation == Operation::ExpandManifest {
        return GraphAnalysis {
            graph: None,
            issues: Vec::new(),
        };
    }
    if request.operation == Operation::CheckBoundaries {
        let stored = load_or_update(request, &mut JavaScriptFrontend);
        if stored.graph.is_some() {
            return GraphAnalysis {
                graph: stored.graph,
                issues: stored.issues.into_iter().map(plan_issue).collect(),
            };
        }
        let workspace_root = Path::new(&request.workspace_root);
        let graph = if workspace_root.is_absolute() && workspace_root.is_dir() {
            let project_roots = manifest_project_roots(request);
            Some(analyze_workspace_graph(
                workspace_root,
                project_roots.as_deref(),
            ))
        } else {
            None
        };
        return GraphAnalysis {
            graph,
            issues: Vec::new(),
        };
    }
    let read_guard_active = request_uses_read_guard(request);
    if request.plan_file.is_some() {
        return GraphAnalysis {
            graph: None,
            issues: Vec::new(),
        };
    }
    let graph_only_op = matches!(request.operation, Operation::Diagnose | Operation::Hotspots);
    let always_needs_graph = graph_only_op || read_guard_active;
    let skip_all_without_cache = request.operation == Operation::Run
        && !request.cache
        && (request.all || request.base.as_deref().is_some_and(is_empty_tree_sha));
    if !always_needs_graph
        && (skip_all_without_cache || (request.only && !request.cache))
    {
        return GraphAnalysis {
            graph: None,
            issues: Vec::new(),
        };
    }
    if !graph_only_op && !graph_analysis_can_change_the_plan(request) {
        return GraphAnalysis {
            graph: None,
            issues: vec![PlanIssue::new(
                "graph-analysis-unneeded",
                "No declared task uses reachability impact, so the dependency graph was not analyzed.",
                IssueSeverity::Info,
                IssueScope::Workspace,
            )],
        };
    }
    let stored = load_or_update(request, &mut JavaScriptFrontend);
    if stored.graph.is_none() && read_guard_active && (request.all || request.only) {
        let workspace_root = Path::new(&request.workspace_root);
        let graph = if workspace_root.is_absolute() && workspace_root.is_dir() {
            let project_roots = manifest_project_roots(request);
            Some(analyze_workspace_graph(
                workspace_root,
                project_roots.as_deref(),
            ))
        } else {
            None
        };
        return GraphAnalysis {
            graph,
            issues: Vec::new(),
        };
    }
    GraphAnalysis {
        graph: stored.graph,
        issues: stored.issues.into_iter().map(plan_issue).collect(),
    }
}

fn plan_issue(issue: StoreIssue) -> PlanIssue {
    PlanIssue::new(
        issue.code,
        issue.message,
        match issue.severity {
            StoreIssueSeverity::Info => IssueSeverity::Info,
            StoreIssueSeverity::Error => IssueSeverity::Error,
        },
        IssueScope::Workspace,
    )
}

fn print_response(response: NativeResponse) {
    match serde_json::to_string(&response) {
        Ok(serialized) => println!("{serialized}"),
        Err(error) => {
            println!(
                "{{\"schemaVersion\":1,\"ok\":false,\"error\":\"Unable to serialize response: {error}\"}}"
            );
        }
    }
}
