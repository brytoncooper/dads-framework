//! Safety-tiered remediation guidance for `dad-test diagnose` findings. Every entry pairs a
//! concrete safe fix with an explicit guardrail warning against unsound shortcuts.
use crate::protocol::{DiagnoseRemediation, RemediationSafety};

const SAFE_DOC_OR_ASSET_EXTS: &[&str] = &[
    "md", "mdx", "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "pdf",
];

pub(crate) fn culprit_remediation(code: &str) -> DiagnoseRemediation {
    match code {
        "nonliteral-dynamic-import" | "nonliteral-commonjs-require" => DiagnoseRemediation {
            safety: RemediationSafety::Safe,
            action: "Replace dynamic import(expr)/require(expr) with a static string-literal map (e.g. const loaders = { a: () => import('./a') }), or isolate CLI/build scripts in a separate non-reachability project.".into(),
            caution: "Do not suppress or ignore this file if any test can execute the dynamic load; hiding it risks skipping broken tests.".into(),
            verify: "Re-run 'dad-test diagnose' to confirm this site disappears, then run the tests covering that loader.".into(),
        },
        "unresolved-bare-module" | "unresolved-local-module" | "unresolved-module-scheme" => {
            DiagnoseRemediation {
                safety: RemediationSafety::Safe,
                action: "Use 'import type' if the import is types-only, or fix the workspace alias / tsconfig paths / package.json exports so resolution succeeds statically.".into(),
                caution: "Do not silence unresolved imports for runtime workspace modules; broken resolution hides real reverse edges.".into(),
                verify: "Re-run 'dad-test diagnose' to confirm resolution succeeds and run typecheck + unit tests.".into(),
            }
        }
        "ambiguous-default-export"
        | "ambiguous-local-export-ownership"
        | "ambiguous-re-export"
        | "ambiguous-cross-file-import" => DiagnoseRemediation {
            safety: RemediationSafety::Safe,
            action: "Prefer explicit named exports and named imports (avoid computed default exports or escaped star namespaces) so symbol reachability stays narrow.".into(),
            caution: "Preserve public API exports while refactoring; migrate internal callers first before removing any default or star export.".into(),
            verify: "Re-run 'dad-test diagnose' and run the owning project's test suite.".into(),
        },
        "generated-or-virtual-module" => DiagnoseRemediation {
            safety: RemediationSafety::VerifyBeforeChanging,
            action: "Isolate generated or virtual module imports in a narrow boundary file imported only by features that depend on them.".into(),
            caution: "Do not mark generator inputs as non-code unless codegen output cannot affect runtime behavior.".into(),
            verify: "Run 'dad-test explain' after editing a generator input to verify dependent tests are still selected.".into(),
        },
        "javascript-parse-failed"
        | "javascript-semantic-failed"
        | "javascript-directory-entry-failed" => DiagnoseRemediation {
            safety: RemediationSafety::Safe,
            action: "Fix the syntax/parse error or keep non-JS build artifacts out of declared project roots.".into(),
            caution: "Do not exclude real source files; fix invalid syntax so static analysis can trace them.".into(),
            verify: "Re-run 'dad-test diagnose' to confirm parse errors drop to 0.".into(),
        },
        _ => DiagnoseRemediation {
            safety: RemediationSafety::KeepWidenedUnlessVerified,
            action: "Inspect the reported location and replace dynamic or unresolvable constructs with static imports/exports where possible.".into(),
            caution: "Widening protects soundness here; never bypass it without confirming tests cannot depend on the uncertain target.".into(),
            verify: "Re-run 'dad-test diagnose' and check impacted tasks with 'dad-test plan'.".into(),
        },
    }
}

pub(crate) fn hotspot_remediation(
    runtime_tests: usize,
    typecheck_tests: usize,
) -> DiagnoseRemediation {
    if runtime_tests == 0 && typecheck_tests > 0 {
        return DiagnoseRemediation {
            safety: RemediationSafety::Safe,
            action: "Type-only coupling: runtime tests already erase 'import type' edges here. Only split this barrel if typecheck latency is a bottleneck.".into(),
            caution: "Do not convert 'import type' edges to value imports; that would turn zero-cost type edges into runtime test coupling.".into(),
            verify: "Run 'dad-test plan' after a type-only edit to verify runtime test tasks skip cleanly.".into(),
        };
    }
    DiagnoseRemediation {
        safety: RemediationSafety::Safe,
        action: "Split this shared hub or barrel by domain and migrate internal callers to direct subpath imports so leaf edits do not fan out across projects.".into(),
        caution: "Do not delete public barrel re-exports while external consumers still import them; migrate internal callers first.".into(),
        verify: "Re-run 'dad-test diagnose' to confirm reached runtime test files decreased, then run tests for affected projects.".into(),
    }
}

pub(crate) fn fallback_trap_remediation(
    kind: &str,
    prefix: &str,
    all_safe_docs_or_assets: bool,
) -> DiagnoseRemediation {
    if kind == "unowned-directory" {
        if all_safe_docs_or_assets {
            return DiagnoseRemediation {
                safety: RemediationSafety::Safe,
                action: "Register a dedicated project entry for this docs/asset directory with no tasks (or docs-only tasks) so edits here do not trigger full-workspace fallback.".into(),
                caution: "Only map this directory to zero tasks if no test reads files inside it at runtime.".into(),
                verify: "Edit a file in this directory and run 'dad-test plan' to confirm full fallback no longer triggers.".into(),
            };
        }
        return DiagnoseRemediation {
            safety: RemediationSafety::VerifyBeforeChanging,
            action: "Declare a project for this directory with its own tasks (or an empty task list if it is an independent non-JS stack such as native mobile).".into(),
            caution: "Do not ignore CI, infra, or shared workspace config directories if tests depend on them; keeping full fallback protects you.".into(),
            verify: "Test a dummy edit in this directory with 'dad-test plan' to confirm only intended tasks run.".into(),
        };
    }

    if prefix.starts_with("*.sql ") {
        return DiagnoseRemediation {
            safety: RemediationSafety::VerifyBeforeChanging,
            action: "Configure 'workspace.sql.migrationRoots' and per-task 'sqlImpact' for table-level narrowing instead of marking '.sql' as non-code.".into(),
            caution: "NEVER add '.sql' to 'workspace.nonCodeSuffixes' — doing so would silently skip database tests on schema changes.".into(),
            verify: "Run 'dad-test plan' on a scoped migration change to confirm only affected database tasks run.".into(),
        };
    }

    if let Some(ext) = prefix_extension(prefix)
        && SAFE_DOC_OR_ASSET_EXTS.contains(&ext)
    {
        return DiagnoseRemediation {
            safety: RemediationSafety::Safe,
            action: format!(
                "Add '.{ext}' to 'workspace.nonCodeSuffixes' if tests never read '.{ext}' files at runtime."
            ),
            caution: "Verify no docs-link, content, or visual-snapshot test reads these files before adding the suffix globally.".into(),
            verify: "Re-run 'dad-test diagnose' to confirm the trap disappears, then verify with 'dad-test plan' on a sample edit.".into(),
        };
    }

    DiagnoseRemediation {
        safety: RemediationSafety::KeepWidenedUnlessVerified,
        action: "Keep widened by default. If these are table-named schema snapshots, configure 'workspace.sql.snapshotPatterns'; otherwise only exclude after auditing that no test reads them via fs/imports.".into(),
        caution: "NEVER blindly add data, fixture, or config suffixes (such as .json, .txt, .yaml, .env) to 'workspace.nonCodeSuffixes' — tests often load them at runtime and skipping them hides real regressions.".into(),
        verify: "Before any exclusion, grep test files for references to these paths and verify with 'dad-test explain' that real fixture edits still select their tests.".into(),
    }
}

pub(crate) fn is_safe_doc_or_asset(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| SAFE_DOC_OR_ASSET_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn prefix_extension(prefix: &str) -> Option<&str> {
    let ext = prefix.strip_prefix("*.")?.split(' ').next()?;
    (!ext.is_empty()).then_some(ext)
}
