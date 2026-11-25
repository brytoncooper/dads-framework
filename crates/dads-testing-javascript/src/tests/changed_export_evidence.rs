use super::fixtures::{commit_fixture, git, request, symbol_fixture};
use crate::changed_module_evidence::changed_module_evidence;
use crate::{analyze_request, analyze_workspace};
use std::fs::{create_dir_all, remove_dir_all, write};

#[test]
fn attributes_a_commonjs_module_value_assignment_to_runtime_importers() {
    let root = std::env::temp_dir().join("dads-testing-javascript-commonjs-module-value");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/leaf.js"),
        "module.exports = {\n  version: 1,\n};\n",
    )
    .expect("fixture CommonJS leaf must be written");
    write(
        root.join("src/importer.js"),
        "const leaf = require('./leaf');\nmodule.exports = leaf;\n",
    )
    .expect("fixture CommonJS importer must be written");
    git(&root, &["init"]);
    git(&root, &["config", "user.email", "testing@example.com"]);
    git(&root, &["config", "user.name", "Dads Testing"]);
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "initial"]);
    write(
        root.join("src/leaf.js"),
        "module.exports = {\n  version: 2,\n};\n",
    )
    .expect("fixture CommonJS module value change must be written");

    let graph = analyze_request(&request(&root)).expect("working-tree graph must be available");
    let reachable = graph.symbol_reachability_from(["src/leaf.js".to_owned()]);
    assert!(reachable.paths.contains("src/importer.js"));
    assert!(
        !reachable
            .uncertainties
            .iter()
            .any(|uncertainty| uncertainty.code == "unattributed-module-change")
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn follows_only_importers_of_a_proven_changed_export() {
    let root = std::env::temp_dir().join("dads-testing-javascript-symbol-evidence");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/leaf.ts"),
        "const internal = 1;\nexport const a = 1;\nexport const b = 1;\n",
    )
    .expect("fixture leaf must be written");
    write(
        root.join("src/a.ts"),
        "import { a } from './leaf'; export const usesA = a;\n",
    )
    .expect("fixture A importer must be written");
    write(
        root.join("src/b.ts"),
        "import { b } from './leaf'; export const usesB = b;\n",
    )
    .expect("fixture B importer must be written");
    git(&root, &["init"]);
    git(&root, &["config", "user.email", "testing@example.com"]);
    git(&root, &["config", "user.name", "Dads Testing"]);
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "initial"]);
    write(
        root.join("src/leaf.ts"),
        "const internal = 1;\nexport const a = 2;\nexport const b = 1;\n",
    )
    .expect("fixture export change must be written");

    let graph = analyze_request(&request(&root)).expect("working-tree graph must be available");
    let reachable = graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);
    assert!(reachable.paths.contains("src/leaf.ts"));
    assert!(reachable.paths.contains("src/a.ts"));
    assert!(!reachable.paths.contains("src/b.ts"));
    assert!(reachable.uncertainties.is_empty());

    write(
        root.join("src/leaf.ts"),
        "const internal = 2;\nexport const a = 2;\nexport const b = 1;\n",
    )
    .expect("fixture internal change must be written");
    let graph = analyze_request(&request(&root)).expect("working-tree graph must be available");
    let reachable = graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);
    assert!(reachable.paths.contains("src/a.ts"));
    assert!(!reachable.paths.contains("src/b.ts"));
    assert!(reachable.uncertainties.is_empty());

    write(
        root.join("src/leaf.ts"),
        "console.log(2);\nexport const a = 2;\nexport const b = 1;\n",
    )
    .expect("fixture impure top-level change must be written");
    let graph = analyze_request(&request(&root)).expect("working-tree graph must be available");
    assert!(graph.module_eval_changed("src/leaf.ts"));
    let reachable = graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);
    assert!(reachable.paths.contains("src/a.ts"));
    assert!(reachable.paths.contains("src/b.ts"));
    assert!(reachable.uncertainties.is_empty());
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn attributes_whitespace_changed_inside_an_exported_string() {
    let root = symbol_fixture("dads-testing-javascript-exported-string-whitespace");
    write(
        root.join("src/leaf.ts"),
        "export const a = 'hello world';\nexport const b = 1;\n",
    )
    .expect("fixture leaf must be written");
    commit_fixture(&root);
    write(
        root.join("src/leaf.ts"),
        "export const a = 'hello  world';\nexport const b = 1;\n",
    )
    .expect("fixture string whitespace change must be written");

    let graph = analyze_request(&request(&root)).expect("working-tree graph must be available");
    let reachable = graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);

    assert!(reachable.paths.contains("src/a.ts"));
    assert!(!reachable.paths.contains("src/b.ts"));
    assert!(reachable.uncertainties.is_empty());
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn attributes_replaced_exports_on_both_sides_of_a_hunk() {
    let root = symbol_fixture("dads-testing-javascript-export-replacement");
    write(root.join("src/leaf.ts"), "export const b = 1;\n").expect("fixture leaf must be written");
    commit_fixture(&root);
    write(root.join("src/leaf.ts"), "export const a = 1;\n")
        .expect("fixture leaf replacement must be written");

    let graph = analyze_request(&request(&root)).expect("replacement graph must be available");
    let reachable = graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);

    assert!(reachable.paths.contains("src/a.ts"));
    assert!(reachable.paths.contains("src/b.ts"));
    assert!(reachable.uncertainties.is_empty());
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn attributes_a_deleted_export_to_its_old_importers() {
    let root = symbol_fixture("dads-testing-javascript-export-deletion");
    write(
        root.join("src/leaf.ts"),
        "export const a = 1;\nexport const b = 1;\n",
    )
    .expect("fixture leaf must be written");
    commit_fixture(&root);
    write(root.join("src/leaf.ts"), "export const a = 1;\n")
        .expect("fixture export deletion must be written");

    let graph = analyze_request(&request(&root)).expect("deletion graph must be available");
    let reachable = graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);

    assert!(reachable.paths.contains("src/b.ts"));
    assert!(
        !reachable
            .uncertainties
            .iter()
            .any(|uncertainty| { uncertainty.code == "unattributed-module-change" })
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn marks_a_completely_untracked_module_as_unattributed() {
    let root = std::env::temp_dir().join("dads-testing-javascript-untracked-module");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/existing.ts"),
        "export const existing = true;\n",
    )
    .expect("tracked fixture must be written");
    commit_fixture(&root);
    write(
        root.join("src/new.ts"),
        "console.log('init'); export const newValue = true;\n",
    )
    .expect("untracked fixture must be written");

    let facts = analyze_workspace(&root);
    let changes = changed_module_evidence(&root, None, &facts.modules)
        .expect("untracked evidence must preserve conservative fallback");
    let change = changes
        .iter()
        .find(|change| change.path == "src/new.ts")
        .expect("untracked module evidence must exist");

    assert!(change.changed_exports.is_empty());
    assert!(!change.every_hunk_is_attributed);
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn accepts_an_explicit_current_head_only_for_a_clean_worktree() {
    let root = symbol_fixture("dads-testing-javascript-explicit-head-cleanliness");
    write(root.join("src/leaf.ts"), "export const a = 1;\n").expect("fixture leaf must be written");
    commit_fixture(&root);

    let mut explicit_head_request = request(&root);
    explicit_head_request.head = Some("HEAD".to_owned());
    assert!(analyze_request(&explicit_head_request).is_some());

    write(root.join("src/leaf.ts"), "export const a = 2;\n")
        .expect("tracked dirty fixture must be written");
    assert!(analyze_request(&explicit_head_request).is_none());

    git(&root, &["checkout", "--", "src/leaf.ts"]);
    write(
        root.join("src/untracked.ts"),
        "export const untracked = true;\n",
    )
    .expect("untracked dirty fixture must be written");
    assert!(analyze_request(&explicit_head_request).is_none());
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn follows_a_changed_export_through_an_export_star_barrel() {
    let root = std::env::temp_dir().join("dads-testing-javascript-export-star");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/leaf.ts"),
        "export const changed = 1;\nexport const unchanged = 1;\n",
    )
    .expect("fixture leaf must be written");
    write(root.join("src/index.ts"), "export * from './leaf';\n")
        .expect("fixture barrel must be written");
    write(
        root.join("src/changed-consumer.ts"),
        "import { changed } from './index'; export const result = changed;\n",
    )
    .expect("fixture changed consumer must be written");
    write(
        root.join("src/unchanged-consumer.ts"),
        "import { unchanged } from './index'; export const result = unchanged;\n",
    )
    .expect("fixture unchanged consumer must be written");
    commit_fixture(&root);
    write(
        root.join("src/leaf.ts"),
        "export const changed = 2;\nexport const unchanged = 1;\n",
    )
    .expect("fixture leaf change must be written");

    let graph = analyze_request(&request(&root)).expect("working-tree graph must be available");
    let reachable = graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);

    assert!(reachable.paths.contains("src/index.ts"));
    assert!(reachable.paths.contains("src/changed-consumer.ts"));
    assert!(!reachable.paths.contains("src/unchanged-consumer.ts"));
    assert!(reachable.uncertainties.is_empty());
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn attributes_a_function_body_hunk_to_only_that_export() {
    let root = symbol_fixture("dads-testing-javascript-function-body");
    write(
        root.join("src/leaf.ts"),
        "export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 1;\n}\n",
    )
    .expect("fixture leaf must be written");
    commit_fixture(&root);
    write(
        root.join("src/leaf.ts"),
        "export function a() {\n  return 2;\n}\n\nexport function b() {\n  return 1;\n}\n",
    )
    .expect("fixture function body change must be written");

    let graph = analyze_request(&request(&root)).expect("working-tree graph must be available");
    let reachable = graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);
    assert!(reachable.paths.contains("src/a.ts"));
    assert!(!reachable.paths.contains("src/b.ts"));
    assert!(reachable.uncertainties.is_empty());
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn attributes_a_class_method_body_hunk_to_the_class_export() {
    let root = symbol_fixture("dads-testing-javascript-class-body");
    write(root.join("src/leaf.ts"), "export class a {\n  value() {\n    return 1;\n  }\n}\n\nexport class b {\n  value() {\n    return 1;\n  }\n}\n")
            .expect("fixture leaf must be written");
    commit_fixture(&root);
    write(root.join("src/leaf.ts"), "export class a {\n  value() {\n    return 2;\n  }\n}\n\nexport class b {\n  value() {\n    return 1;\n  }\n}\n")
            .expect("fixture class method body change must be written");

    let graph = analyze_request(&request(&root)).expect("working-tree graph must be available");
    let reachable = graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);
    assert!(reachable.paths.contains("src/a.ts"));
    assert!(!reachable.paths.contains("src/b.ts"));
    assert!(reachable.uncertainties.is_empty());
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn attributes_an_exported_const_initializer_hunk_to_that_const() {
    let root = symbol_fixture("dads-testing-javascript-const-initializer");
    write(root.join("src/leaf.ts"), "export const a = makeValue(\n  1,\n);\n\nexport const b = makeValue(\n  1,\n);\n\nfunction makeValue(value: number) {\n  return value;\n}\n")
            .expect("fixture leaf must be written");
    commit_fixture(&root);
    // Unannotated top-level function call may have module-load side effects, so editing it must
    // propagate along runtime import edges (`module_eval_changed`) and reach `src/b.ts` too.
    write(root.join("src/leaf.ts"), "export const a = makeValue(\n  2,\n);\n\nexport const b = makeValue(\n  1,\n);\n\nfunction makeValue(value: number) {\n  return value;\n}\n")
            .expect("fixture const initializer change must be written");

    let graph = analyze_request(&request(&root)).expect("working-tree graph must be available");
    assert!(graph.module_eval_changed("src/leaf.ts"));
    let reachable = graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);
    assert!(reachable.paths.contains("src/a.ts"));
    assert!(reachable.paths.contains("src/b.ts"));
    assert!(reachable.uncertainties.is_empty());

    // Annotated `/*#__PURE__*/` calls narrow strictly to importers of `a`.
    write(root.join("src/leaf.ts"), "export const a = /*#__PURE__*/ makeValue(\n  1,\n);\n\nexport const b = /*#__PURE__*/ makeValue(\n  1,\n);\n\nfunction makeValue(value: number) {\n  return value;\n}\n")
            .expect("pure fixture leaf must be written");
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "annotate pure"]);
    write(root.join("src/leaf.ts"), "export const a = /*#__PURE__*/ makeValue(\n  2,\n);\n\nexport const b = /*#__PURE__*/ makeValue(\n  1,\n);\n\nfunction makeValue(value: number) {\n  return value;\n}\n")
            .expect("pure const initializer change must be written");

    let pure_graph = analyze_request(&request(&root)).expect("pure graph must be available");
    assert!(!pure_graph.module_eval_changed("src/leaf.ts"));
    let pure_reachable = pure_graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);
    assert!(pure_reachable.paths.contains("src/a.ts"));
    assert!(!pure_reachable.paths.contains("src/b.ts"));
    assert!(pure_reachable.uncertainties.is_empty());
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn attributes_pure_private_helper_to_calling_exports_without_widening() {
    let root = symbol_fixture("dads-testing-javascript-helper-body");
    write(
        root.join("src/leaf.ts"),
        "function inner() {\n  return 1;\n}\n\nconst helper = () => inner();\n\nexport function a() {\n  return helper();\n}\n\nexport function b() {\n  return 0;\n}\n",
    )
    .expect("fixture leaf must be written");
    commit_fixture(&root);
    write(
        root.join("src/leaf.ts"),
        "function inner() {\n  return 2;\n}\n\nconst helper = () => inner();\n\nexport function a() {\n  return helper();\n}\n\nexport function b() {\n  return 0;\n}\n",
    )
    .expect("fixture helper body change must be written");

    let graph = analyze_request(&request(&root)).expect("working-tree graph must be available");
    let reachable = graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);
    assert!(reachable.paths.contains("src/a.ts"));
    assert!(!reachable.paths.contains("src/b.ts"));
    assert!(
        reachable.uncertainties.is_empty(),
        "pure multi-hop private helper must narrow cleanly: {:?}",
        reachable.uncertainties
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn keeps_impure_module_private_helper_edit_conservative() {
    let root = symbol_fixture("dads-testing-javascript-impure-helper-body");
    write(
        root.join("src/leaf.ts"),
        "function helper() {\n  return 1;\n}\nconsole.log(helper());\nexport function a() {\n  return helper();\n}\nexport function b() {\n  return 0;\n}\n",
    )
    .expect("fixture impure leaf must be written");
    commit_fixture(&root);
    write(
        root.join("src/leaf.ts"),
        "function helper() {\n  return 2;\n}\nconsole.log(helper());\nexport function a() {\n  return helper();\n}\nexport function b() {\n  return 0;\n}\n",
    )
    .expect("fixture impure helper change must be written");

    let graph = analyze_request(&request(&root)).expect("working-tree graph must be available");
    assert!(graph.module_eval_changed("src/leaf.ts"));
    let reachable = graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);
    assert!(reachable.paths.contains("src/a.ts"));
    assert!(reachable.paths.contains("src/b.ts"));
    assert!(reachable.uncertainties.is_empty());
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn attributes_overloaded_typescript_function_without_widening() {
    let root = symbol_fixture("dads-testing-javascript-overloaded-fn");
    write(
        root.join("src/leaf.ts"),
        "export function a(): number;\nexport function a(x: number): number;\nexport function a(x?: number): number {\n  return (x ?? 0) + 1;\n}\n\nexport function b() {\n  return 1;\n}\n",
    )
    .expect("fixture overloaded leaf must be written");
    commit_fixture(&root);
    write(
        root.join("src/leaf.ts"),
        "export function a(): number;\nexport function a(x: number): number;\nexport function a(x?: number): number {\n  return (x ?? 0) + 2;\n}\n\nexport function b() {\n  return 1;\n}\n",
    )
    .expect("fixture overloaded body change must be written");

    let graph = analyze_request(&request(&root)).expect("working-tree graph must be available");
    let reachable = graph.symbol_reachability_from(["src/leaf.ts".to_owned()]);
    assert!(reachable.paths.contains("src/a.ts"));
    assert!(!reachable.paths.contains("src/b.ts"));
    assert!(
        reachable.uncertainties.is_empty(),
        "overloaded TS functions must not widen: {:?}",
        reachable.uncertainties
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}
