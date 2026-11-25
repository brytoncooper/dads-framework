use dads_testing_core::graph::DependencyGraph;
use dads_testing_core::{
    IssueScope, IssueSeverity, NativeRequest, NativeResponse, Operation, PlanIssue,
    TaskReceiptStore, execute_request_with_graph_and_receipts, graph_analysis_can_change_the_plan,
    is_empty_tree_sha,
};
use dads_testing_javascript::JavaScriptFrontend;
use dads_testing_store::{FileReceiptStore, StoreIssue, StoreIssueSeverity, load_or_update};
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
    let receipt_store = if request.cache {
        let remote_url = request.remote_cache_url.clone().or_else(|| {
            std::env::var("DADS_TESTING_REMOTE_CACHE_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
        });
        let remote_token = std::env::var("DADS_TESTING_REMOTE_CACHE_TOKEN")
            .ok()
            .filter(|value| !value.trim().is_empty());
        FileReceiptStore::for_workspace(Path::new(&request.workspace_root)).map(|store| {
            match remote_url {
                Some(url) => store.with_remote_url(&url, remote_token),
                None => store,
            }
        })
    } else {
        None
    };
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
    if request.operation != Operation::Diagnose
        && (request.all
            || request.only
            || request.plan_file.is_some()
            || request.base.as_deref().is_some_and(is_empty_tree_sha))
    {
        return GraphAnalysis {
            graph: None,
            issues: Vec::new(),
        };
    }
    if request.operation != Operation::Diagnose && !graph_analysis_can_change_the_plan(request) {
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
