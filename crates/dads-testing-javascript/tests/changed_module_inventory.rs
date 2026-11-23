use dads_testing_core::graph::DependencyGraph;
use dads_testing_core::{NativeRequest, Operation, execute_request_with_graph};
use dads_testing_javascript::analyze_request;
use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static WORKSPACE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn retains_export_selection_for_unstaged_staged_and_historical_changes()
-> Result<(), Box<dyn Error>> {
    for state in ["unstaged", "staged", "historical"] {
        let workspace = TemporaryWorkspace::create("lib/value.ts", 0)?;
        let base = workspace.git(&["rev-parse", "HEAD"])?;
        workspace.write(
            "lib/value.ts",
            "export const alpha = 3;\nexport const beta = 2;\n",
        )?;
        if state != "unstaged" {
            workspace.git(&["add", "--all"])?;
        }
        let mut request = workspace.request();
        if state == "historical" {
            workspace.git(&["commit", "--quiet", "--message", "change alpha"])?;
            workspace.git(&[
                "commit",
                "--quiet",
                "--allow-empty",
                "--message",
                "later HEAD",
            ])?;
            request.base = Some(base);
            request.head = Some("HEAD".to_owned());
        }
        let graph = analyze_request(&request).ok_or("missing changed graph")?;
        assert_alpha_evidence(&graph, "lib/value.ts");
        let response = execute_request_with_graph(request, Some(graph));
        assert!(response.ok, "{response:?}");
        let plan = response.result.ok_or("missing plan")?.plan;
        let selected = plan
            .tasks
            .iter()
            .filter(|task| task.decision == "run")
            .map(|task| task.id.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(selected, BTreeSet::from(["app-a:test", "lib:test"]));
        assert!(!plan.scope.full_fallback);
    }
    Ok(())
}

#[test]
fn preserves_literal_and_nul_delimited_module_paths() -> Result<(), Box<dyn Error>> {
    for path in [
        "lib/value[1].ts",
        "lib/space name\tline\n.ts",
        ":(glob)value*.ts",
    ] {
        let workspace = TemporaryWorkspace::create(path, 0)?;
        workspace.write(path, "export const alpha = 3;\nexport const beta = 2;\n")?;
        let graph = analyze_request(&workspace.request()).ok_or("missing odd-path graph")?;
        assert_alpha_evidence(&graph, path);
    }
    Ok(())
}

#[test]
fn preserves_added_and_untracked_module_attribution() -> Result<(), Box<dyn Error>> {
    let workspace = TemporaryWorkspace::create("lib/value.ts", 0)?;
    workspace.write("lib/added.ts", "export const added = 1;\n")?;
    workspace.git(&["add", "--", "lib/added.ts"])?;
    workspace.write("lib/untracked.ts", "export const untracked = 1;\n")?;
    workspace.write(
        "lib/untracked-impure.ts",
        "console.log('side-effect');\nexport const impure = 1;\n",
    )?;
    let graph = analyze_request(&workspace.request()).ok_or("missing new-module graph")?;
    assert_eq!(
        graph.changed_exports("lib/added.ts"),
        Some(BTreeSet::from(["added".to_owned()]))
    );
    assert!(graph.contains_path("lib/untracked.ts"));
    assert_eq!(
        graph.changed_exports("lib/untracked.ts"),
        Some(BTreeSet::from(["untracked".to_owned()]))
    );
    assert!(graph.contains_path("lib/untracked-impure.ts"));
    assert!(graph.changed_exports("lib/untracked-impure.ts").is_none());
    let reachable = graph.symbol_reachability_from(["lib/untracked-impure.ts".to_owned()]);
    assert!(
        reachable
            .uncertainties
            .iter()
            .any(|issue| issue.code == "unattributed-module-change")
    );
    Ok(())
}

#[test]
fn refuses_unavailable_comparisons_and_failed_inventory() -> Result<(), Box<dyn Error>> {
    let workspace = TemporaryWorkspace::create("lib/value.ts", 0)?;
    for base in ["missing-comparison-ref", "--output=unexpected-file"] {
        let mut request = workspace.request();
        request.base = Some(base.to_owned());
        assert!(analyze_request(&request).is_none());
    }
    assert!(!workspace.root().join("unexpected-file").exists());
    fs::write(workspace.root().join(".git/index"), "invalid index")?;
    assert!(analyze_request(&workspace.request()).is_none());
    Ok(())
}

#[cfg(unix)]
#[test]
fn refuses_a_non_utf8_changed_path_inventory() -> Result<(), Box<dyn Error>> {
    use std::os::unix::fs::PermissionsExt;

    let workspace = TemporaryWorkspace::create("lib/value.ts", 0)?;
    let inherited_path = std::env::var_os("PATH").ok_or("missing executable PATH")?;
    let real_git = std::env::split_paths(&inherited_path)
        .map(|directory| directory.join("git"))
        .find(|candidate| {
            fs::metadata(candidate).is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
        .ok_or("missing executable Git")?
        .canonicalize()?;
    let shim_directory = workspace.0.join("git-shim");
    fs::create_dir(&shim_directory)?;
    let shim = shim_directory.join("git");
    fs::write(
        &shim,
        r#"#!/bin/sh
if [ "$#" -eq 6 ] && [ "$1" = diff ] && [ "$2" = --name-only ] && [ "$3" = --no-renames ] && [ "$4" = -z ] && [ "$6" = -- ]; then
    printf 'invalid-\377.txt\000' > "$DADS_JS_EVIDENCE_INVENTORY_MARKER"
    printf 'invalid-\377.txt\000'
    exit 0
fi
exec "$DADS_JS_EVIDENCE_REAL_GIT" "$@"
"#,
    )?;
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o755))?;
    let child_path = std::env::join_paths(
        std::iter::once(shim_directory).chain(std::env::split_paths(&inherited_path)),
    )?;
    let marker = workspace.0.join("injected-inventory");
    let completed = Command::new(std::env::current_exe()?)
        .args(["--exact", "trace_changed_modules_child", "--nocapture"])
        .env("PATH", child_path)
        .env("DADS_JS_EVIDENCE_WORKSPACE", workspace.root())
        .env("DADS_JS_EVIDENCE_REAL_GIT", real_git)
        .env("DADS_JS_EVIDENCE_INVENTORY_MARKER", &marker)
        .env("DADS_JS_EVIDENCE_INVALID_INVENTORY", "1")
        .output()?;
    assert!(
        completed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&completed.stdout),
        String::from_utf8_lossy(&completed.stderr)
    );
    assert_eq!(fs::read(marker)?, b"invalid-\xff.txt\0");
    Ok(())
}

#[test]
fn git_diff_count_scales_with_changed_modules_instead_of_graph_size() -> Result<(), Box<dyn Error>>
{
    for unchanged_count in [12, 240] {
        let workspace = TemporaryWorkspace::create("lib/value.ts", unchanged_count)?;
        workspace.write(
            "lib/value.ts",
            "export const alpha = 3;\nexport const beta = 2;\n",
        )?;
        workspace.write("lib/second.ts", "export const second = 4;\n")?;
        workspace.git(&["add", "--", "lib/second.ts"])?;
        workspace.write("lib/untracked.ts", "export const untracked = 1;\n")?;
        let trace_path = workspace.0.join("git.trace");
        let completed = Command::new(std::env::current_exe()?)
            .args(["--exact", "trace_changed_modules_child", "--nocapture"])
            .env("DADS_JS_EVIDENCE_WORKSPACE", workspace.root())
            .env("GIT_TRACE", &trace_path)
            .output()?;
        assert!(
            completed.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&completed.stdout),
            String::from_utf8_lossy(&completed.stderr)
        );
        let trace = fs::read_to_string(trace_path)?;
        let diffs = trace
            .lines()
            .filter(|line| line.contains("built-in: git diff "))
            .collect::<Vec<_>>();
        assert_eq!(
            diffs.len(),
            3,
            "expected one inventory and two changed-file diffs: {trace}"
        );
        assert_eq!(
            diffs
                .iter()
                .filter(|line| line.contains("--name-only"))
                .count(),
            1
        );
        assert_eq!(
            diffs
                .iter()
                .filter(|line| line.contains("--unified=0"))
                .count(),
            2
        );
    }
    Ok(())
}

// Git tracing and injected output are confined to a child, never shared process environment.
#[test]
fn trace_changed_modules_child() -> Result<(), Box<dyn Error>> {
    let Some(root) = std::env::var_os("DADS_JS_EVIDENCE_WORKSPACE") else {
        return Ok(());
    };
    let graph = analyze_request(&request(Path::new(&root)));
    if std::env::var_os("DADS_JS_EVIDENCE_INVALID_INVENTORY").is_some() {
        assert!(
            graph.is_none(),
            "non-UTF-8 inventory must refuse graph evidence"
        );
        return Ok(());
    }
    let graph = graph.ok_or("missing traced graph")?;
    assert_alpha_evidence(&graph, "lib/value.ts");
    assert_eq!(
        graph.changed_exports("lib/second.ts"),
        Some(BTreeSet::from(["second".to_owned()]))
    );
    assert!(graph.contains_path("lib/untracked.ts"));
    assert_eq!(
        graph.changed_exports("lib/untracked.ts"),
        Some(BTreeSet::from(["untracked".to_owned()]))
    );
    Ok(())
}

fn assert_alpha_evidence(graph: &DependencyGraph, path: &str) {
    assert_eq!(
        graph.changed_exports(path),
        Some(BTreeSet::from(["alpha".to_owned()]))
    );
    let reachable = graph.symbol_reachability_from([path.to_owned()]);
    assert_eq!(
        reachable.paths,
        BTreeSet::from([path.to_owned(), "app-a/index.ts".to_owned()])
    );
    assert!(
        reachable.uncertainties.is_empty(),
        "{:?}",
        reachable.uncertainties
    );
}

struct TemporaryWorkspace(PathBuf);

impl TemporaryWorkspace {
    fn create(module_path: &str, unchanged_count: usize) -> Result<Self, Box<dyn Error>> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let sequence = WORKSPACE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "dads-module-inventory-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&directory)?;
        let workspace = Self(directory);
        fs::create_dir(workspace.root())?;
        workspace.write(
            module_path,
            "export const alpha = 1;\nexport const beta = 2;\n",
        )?;
        let specifier = format!(
            "../{}",
            module_path
                .replace('\\', "\\\\")
                .replace('\'', "\\'")
                .replace('\n', "\\n")
                .replace('\t', "\\t")
        );
        workspace.write(
            "app-a/index.ts",
            &format!("import {{ alpha }} from '{specifier}'; export const result = alpha;\n"),
        )?;
        workspace.write(
            "app-b/index.ts",
            &format!("import {{ beta }} from '{specifier}'; export const result = beta;\n"),
        )?;
        workspace.write("independent/index.ts", "export const independent = 1;\n")?;
        workspace.write("dads.testing.json", MANIFEST)?;
        for index in 0..unchanged_count {
            workspace.write(
                &format!("lib/unchanged-{index}.ts"),
                "export const unchanged = 1;\n",
            )?;
        }
        workspace.git(&["init", "--quiet"])?;
        workspace.git(&["config", "user.email", "testing@dads.invalid"])?;
        workspace.git(&["config", "user.name", "Dads Testing"])?;
        workspace.git(&["add", "--all"])?;
        workspace.git(&["commit", "--quiet", "--message", "baseline"])?;
        Ok(workspace)
    }

    fn root(&self) -> PathBuf {
        self.0.join("workspace")
    }

    fn request(&self) -> NativeRequest {
        request(&self.root())
    }

    fn write(&self, path: &str, contents: &str) -> Result<(), Box<dyn Error>> {
        let absolute_path = self.root().join(path);
        fs::create_dir_all(absolute_path.parent().ok_or("missing fixture parent")?)?;
        fs::write(absolute_path, contents)?;
        Ok(())
    }

    fn git(&self, arguments: &[&str]) -> Result<String, Box<dyn Error>> {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(self.root())
            .output()?;
        if !output.status.success() {
            return Err(format!(
                "git {arguments:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )
            .into());
        }
        Ok(String::from_utf8(output.stdout)?.trim().to_owned())
    }
}

impl Drop for TemporaryWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn request(root: &Path) -> NativeRequest {
    NativeRequest {
        schema_version: 1,
        operation: Operation::Plan,
        workspace_root: root.to_string_lossy().into_owned(),
        manifest_path: None,
        base: None,
        head: None,
        all: false,
        task_ids: Vec::new(),
        jobs: None,
        cache: false,
        remote_cache_url: None,
    }
}

const MANIFEST: &str = r#"{
  "schemaVersion": 1,
  "workspace": {"root": ".", "fullFallback": {"taskIds": ["lib:test", "app-a:test", "app-b:test", "independent:test"]}},
  "projects": [
    {"id": "lib", "root": "lib", "fallbackDependencies": []},
    {"id": "app-a", "root": "app-a", "fallbackDependencies": ["lib"]},
    {"id": "app-b", "root": "app-b", "fallbackDependencies": ["lib"]},
    {"id": "independent", "root": "independent", "fallbackDependencies": []}
  ],
  "tasks": [
    {"id": "lib:test", "project": "lib", "kind": "test", "execution": {"executable": "node", "args": ["--version"]}, "dependsOn": [], "impact": {"mode": "reachability"}},
    {"id": "app-a:test", "project": "app-a", "kind": "test", "execution": {"executable": "node", "args": ["--version"]}, "dependsOn": [], "impact": {"mode": "reachability"}},
    {"id": "app-b:test", "project": "app-b", "kind": "test", "execution": {"executable": "node", "args": ["--version"]}, "dependsOn": [], "impact": {"mode": "reachability"}},
    {"id": "independent:test", "project": "independent", "kind": "test", "execution": {"executable": "node", "args": ["--version"]}, "dependsOn": [], "impact": {"mode": "reachability"}}
  ]
}"#;
