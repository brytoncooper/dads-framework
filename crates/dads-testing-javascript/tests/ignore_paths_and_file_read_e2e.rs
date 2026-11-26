//! End-to-end Oxc + Core tests for:
//! 1. `workspace.ignorePaths` excluding nested `eslint.config.mjs` stubs from the JS graph,
//!    project fallback graph, `cacheInputs.projectRoots`, and `diagnose` traps while honoring
//!    explicit `impact.paths` (such as root `eslint.config.mjs`).
//! 2. Real Oxc `fs.readFileSync`/`readdirSync` (`FileRead`) vs `import.meta.glob` (`Runtime`).
//! 3. `--all` with `JavaScriptFrontend` producing sound `v4` `cacheInputs`.

use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, PlanResult, execute_request_with_graph,
};
use dads_testing_javascript::{JavaScriptFrontend, analyze_request};
use dads_testing_store::load_or_update;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct Repo(PathBuf);

impl Repo {
    fn new(label: &str) -> Result<Self, Box<dyn Error>> {
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("dads-js-e2e-{label}-{}-{seq}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root)?;
        Ok(Self(root))
    }

    fn write(&self, rel: &str, content: &str) -> Result<(), Box<dyn Error>> {
        let full = self.0.join(rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(full, content)?;
        Ok(())
    }

    fn git(&self, args: &[&str]) -> Result<(), Box<dyn Error>> {
        let out = Command::new("git")
            .args(args)
            .current_dir(&self.0)
            .output()?;
        if !out.status.success() {
            return Err(format!(
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            )
            .into());
        }
        Ok(())
    }

    fn init_commit(&self) -> Result<(), Box<dyn Error>> {
        self.git(&["init", "-q"])?;
        self.git(&["config", "user.email", "test@dads.invalid"])?;
        self.git(&["config", "user.name", "Dads Test"])?;
        self.git(&["add", "."])?;
        self.git(&["commit", "-qm", "baseline"])?;
        Ok(())
    }

    fn plan(&self) -> Result<PlanResult, Box<dyn Error>> {
        let req = NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Plan,
            workspace_root: self.0.display().to_string(),
            base: Some("HEAD".to_owned()),
            ..NativeRequest::default()
        };
        let graph = analyze_request(&req).ok_or("missing graph")?;
        let resp = execute_request_with_graph(req, Some(graph));
        if !resp.ok {
            return Err(format!("plan failed: {:?}", resp.error).into());
        }
        Ok(resp.result.ok_or("missing result")?.plan)
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn task_decision<'a>(
    plan: &'a PlanResult,
    id: &str,
) -> Result<&'a dads_testing_core::TaskDecision, Box<dyn Error>> {
    plan.tasks
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("missing task {id}").into())
}

fn setup_ignore_paths_eslint_repo() -> Result<Repo, Box<dyn Error>> {
    let repo = Repo::new("ignore-paths-eslint")?;
    let manifest = r#"{
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "ignorePaths": ["apps/**/eslint.config.mjs", "libs/**/eslint.config.mjs"],
            "fullFallback": { "taskIds": ["web:test", "web:lint", "api:test", "api:lint", "scripts:test"] }
        },
        "projects": [
            { "id": "command", "root": ".", "fallbackDependencies": [] },
            { "id": "workspace-scripts", "root": "scripts", "fallbackDependencies": [] },
            { "id": "web", "root": "apps/web", "fallbackDependencies": [] },
            { "id": "api", "root": "apps/api", "fallbackDependencies": [] }
        ],
        "tasks": [
            { "id": "web:test", "project": "web", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
            { "id": "web:lint", "project": "web", "kind": "lint", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability", "paths": ["eslint.config.mjs"] } },
            { "id": "api:test", "project": "api", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
            { "id": "api:lint", "project": "api", "kind": "lint", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability", "paths": ["eslint.config.mjs"] } },
            { "id": "scripts:test", "project": "workspace-scripts", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
        ]
    }"#;
    repo.write("dads.testing.json", manifest)?;
    repo.write(
        "scripts/eslint-helper.mjs",
        "export const rules = ['strict'];\n",
    )?;
    repo.write(
        "eslint.config.mjs",
        "import { rules } from './scripts/eslint-helper.mjs';\nexport default rules;\n",
    )?;
    repo.write(
        "apps/web/eslint.config.mjs",
        "import base from '../../eslint.config.mjs';\nexport default base;\n",
    )?;
    repo.write(
        "apps/api/eslint.config.mjs",
        "import base from '../../eslint.config.mjs';\nexport default base;\n",
    )?;
    repo.write("apps/web/src/page.ts", "export const page = 1;\n")?;
    repo.write("apps/api/src/server.ts", "export const server = 1;\n")?;
    repo.init_commit()?;
    Ok(repo)
}

#[test]
fn workspace_ignore_paths_excludes_nested_eslint_configs_from_graph_and_cache_roots()
-> Result<(), Box<dyn Error>> {
    let repo = setup_ignore_paths_eslint_repo()?;

    // 1. Editing `scripts/eslint-helper.mjs` does NOT reach `web` or `api`.
    repo.write(
        "scripts/eslint-helper.mjs",
        "export const rules = ['strict', 'extra'];\n",
    )?;
    let helper_plan = repo.plan()?;
    assert_eq!(task_decision(&helper_plan, "scripts:test")?.decision, "run");
    assert_eq!(
        task_decision(&helper_plan, "web:test")?.decision,
        "skip-proven-unaffected"
    );
    assert_eq!(
        task_decision(&helper_plan, "api:test")?.decision,
        "skip-proven-unaffected"
    );

    // 2. Editing root `eslint.config.mjs` STILL triggers `web:lint` and `api:lint` via impact.paths.
    repo.git(&["checkout", "--", "scripts/eslint-helper.mjs"])?;
    repo.write(
        "eslint.config.mjs",
        "import { rules } from './scripts/eslint-helper.mjs';\nexport default [...rules, 'a'];\n",
    )?;
    let lint_plan = repo.plan()?;
    assert_eq!(task_decision(&lint_plan, "web:lint")?.decision, "run");
    assert_eq!(task_decision(&lint_plan, "api:lint")?.decision, "run");
    assert_eq!(
        task_decision(&lint_plan, "web:test")?.decision,
        "skip-proven-unaffected"
    );
    assert_eq!(
        task_decision(&lint_plan, "api:test")?.decision,
        "skip-proven-unaffected"
    );

    // 3. Under `--all`, `web:test` has `projectRoots == ["apps/web"]` and `cacheable == true`.
    repo.git(&["checkout", "--", "eslint.config.mjs"])?;
    let all_req = NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: repo.0.display().to_string(),
        all: true,
        ..NativeRequest::default()
    };
    let mut frontend = JavaScriptFrontend;
    let stored = load_or_update(&all_req, &mut frontend);
    let graph = stored.graph.ok_or("expected graph on --all")?;
    assert!(!graph.contains_path("apps/web/eslint.config.mjs"));
    assert!(!graph.contains_path("apps/api/eslint.config.mjs"));
    let all_plan = execute_request_with_graph(all_req, Some(graph.clone()))
        .result
        .ok_or("missing all plan")?
        .plan;
    let web_ci = task_decision(&all_plan, "web:test")?
        .cache_inputs
        .as_ref()
        .ok_or("missing cacheInputs")?;
    assert!(web_ci.cacheable);
    assert_eq!(web_ci.project_roots, vec!["apps/web"]);

    // 4. `diagnose` must NOT report ignored `apps/**/eslint.config.mjs` as fallback traps.
    let diag = execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Diagnose,
            workspace_root: repo.0.display().to_string(),
            ..NativeRequest::default()
        },
        Some(graph),
    )
    .result
    .and_then(|r| r.diagnose)
    .ok_or("missing diagnose")?;
    assert!(
        !diag.fallback_traps.iter().any(|t| t
            .sample_paths
            .iter()
            .any(|p| p.ends_with("eslint.config.mjs"))),
        "ignored eslint.config.mjs files must not appear in fallback traps: {:?}",
        diag.fallback_traps
    );
    Ok(())
}

fn setup_oxc_fs_vs_glob_repo() -> Result<Repo, Box<dyn Error>> {
    let repo = Repo::new("oxc-fs-vs-glob")?;
    let manifest = r#"{
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["web:test", "scripts:test", "unrelated:test"] }
        },
        "projects": [
            { "id": "feature", "root": "libs/feature", "fallbackDependencies": [] },
            { "id": "web", "root": "apps/web", "fallbackDependencies": [] },
            { "id": "scripts", "root": "scripts", "fallbackDependencies": [] },
            { "id": "unrelated", "root": "libs/unrelated", "fallbackDependencies": [] }
        ],
        "tasks": [
            {
                "id": "web:test",
                "project": "web",
                "kind": "test",
                "execution": { "executable": "true", "fileNarrowing": { "suffixes": [".test.ts", ".test.tsx"] } },
                "dependsOn": [],
                "impact": { "mode": "reachability" }
            },
            {
                "id": "scripts:test",
                "project": "scripts",
                "kind": "test",
                "execution": { "executable": "true", "fileNarrowing": { "suffixes": [".test.mjs"] } },
                "dependsOn": [],
                "impact": { "mode": "reachability" }
            },
            {
                "id": "unrelated:test",
                "project": "unrelated",
                "kind": "test",
                "execution": { "executable": "true" },
                "dependsOn": [],
                "impact": { "mode": "reachability" }
            }
        ]
    }"#;
    repo.write("dads.testing.json", manifest)?;
    repo.write(
        "libs/feature/src/section.tsx",
        "export function Section() { return 'ok'; }\n",
    )?;
    repo.write(
        "apps/web/src/main.tsx",
        "import { Section } from '../../../libs/feature/src/section';\nconsole.log(Section());\n",
    )?;
    repo.write(
        "apps/web/src/routes/home.tsx",
        "import { Section } from '../../../../libs/feature/src/section';\nexport const home = () => Section();\n",
    )?;
    repo.write(
        "apps/web/src/routes/-home.test.tsx",
        "import { home } from './home';\nconsole.log(home());\n",
    )?;
    repo.write(
        "apps/web/src/locale.test.tsx",
        "import { readFileSync } from 'node:fs';\nreadFileSync(new URL('./main.tsx', import.meta.url), 'utf8');\n",
    )?;
    repo.write(
        "apps/web/src/routes-audit.test.ts",
        "import { readdirSync } from 'node:fs';\nreaddirSync(new URL('./routes', import.meta.url));\n",
    )?;
    repo.write(
        "apps/web/src/glob-loader.test.ts",
        "export const mods = import.meta.glob('./routes/*.tsx', { eager: true });\n",
    )?;
    repo.write(
        "scripts/check-web.test.mjs",
        "import { readFileSync } from 'node:fs';\nreadFileSync('apps/web/src/main.tsx', 'utf8');\n",
    )?;
    repo.write("libs/unrelated/src/u.ts", "export const u = 1;\n")?;
    repo.init_commit()?;
    Ok(repo)
}

#[test]
fn real_oxc_fs_read_stays_direct_while_meta_glob_stays_transitive_and_deletions_still_hit()
-> Result<(), Box<dyn Error>> {
    let repo = setup_oxc_fs_vs_glob_repo()?;

    // 1. Transitive edit in `libs/feature/src/section.tsx`: ZERO uncertainties, narrow `web:test`,
    //    `scripts:test` and `unrelated:test` skipped.
    repo.write(
        "libs/feature/src/section.tsx",
        "export function Section() { return 'updated'; }\n",
    )?;
    let transitive_plan = repo.plan()?;
    assert!(
        transitive_plan.issues.is_empty(),
        "unexpected issues: {:?}",
        transitive_plan.issues
    );
    let web = task_decision(&transitive_plan, "web:test")?;
    assert_eq!(web.decision, "run");
    assert!(!web.widened);
    assert_eq!(
        web.selected_files,
        vec![
            "apps/web/src/glob-loader.test.ts".to_owned(),
            "apps/web/src/routes/-home.test.tsx".to_owned(),
        ]
    );
    assert_eq!(
        task_decision(&transitive_plan, "scripts:test")?.decision,
        "skip-proven-unaffected"
    );
    assert_eq!(
        task_decision(&transitive_plan, "unrelated:test")?.decision,
        "skip-proven-unaffected"
    );

    // 2. Direct edit to `apps/web/src/main.tsx`: DOES reach `locale.test.tsx` AND `scripts/check-web.test.mjs`!
    repo.git(&["checkout", "--", "libs/feature/src/section.tsx"])?;
    repo.write(
        "apps/web/src/main.tsx",
        "import { Section } from '../../../libs/feature/src/section';\nconsole.log(Section(), 'v2');\n",
    )?;
    let direct_plan = repo.plan()?;
    assert!(
        direct_plan.issues.is_empty(),
        "unexpected issues: {:?}",
        direct_plan.issues
    );
    assert_eq!(
        task_decision(&direct_plan, "web:test")?.selected_files,
        vec!["apps/web/src/locale.test.tsx".to_owned()]
    );
    assert_eq!(
        task_decision(&direct_plan, "scripts:test")?.selected_files,
        vec!["scripts/check-web.test.mjs".to_owned()]
    );
    assert_eq!(
        task_decision(&direct_plan, "unrelated:test")?.decision,
        "skip-proven-unaffected"
    );

    // 3. Deleting a file inside `apps/web/src/routes/` reaches `routes-audit.test.ts`!
    repo.git(&["checkout", "--", "apps/web/src/main.tsx"])?;
    fs::remove_file(Path::new(&repo.0).join("apps/web/src/routes/-home.test.tsx"))?;
    let delete_plan = repo.plan()?;
    assert_eq!(task_decision(&delete_plan, "web:test")?.decision, "run");
    assert_eq!(
        task_decision(&delete_plan, "scripts:test")?.decision,
        "skip-proven-unaffected"
    );
    Ok(())
}
