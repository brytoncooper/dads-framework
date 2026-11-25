//! Section C (#79-#85) DST fixtures: default re-export gymnastics, decorators, tagged templates,
//! TS namespaces + declaration merging + const enum, `new CustomClass()` + impure `Map`,
//! `pureFactories` precision & impure-arg trap, and diamond `export *` shadowing.

use std::fs;
use std::path::Path;

pub fn write_lang_edge_workspace(root: &Path) -> Result<Vec<String>, String> {
    write_reexport_and_decorator_fixtures(root)?;
    write_ns_new_factory_diamond_fixtures(root)?;
    write_lang_edge_tests(root)?;
    Ok(vec![
        "adv/lang-edge-reexport.test.ts".to_owned(),
        "adv/lang-edge-decorators.test.ts".to_owned(),
        "adv/lang-edge-tagged.test.ts".to_owned(),
        "adv/lang-edge-ns.test.ts".to_owned(),
        "adv/lang-edge-new.test.ts".to_owned(),
        "adv/lang-edge-pure-factory.test.ts".to_owned(),
        "adv/lang-edge-diamond-shadow.test.ts".to_owned(),
        "adv/lang-edge-diamond-leaf.test.ts".to_owned(),
    ])
}

fn write_reexport_and_decorator_fixtures(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "lang/def-hop-a.ts",
        "export default function calc(n: number): number { return n * 2; }\n",
    )?;
    write_file(
        root,
        "lang/def-hop-b.ts",
        "export { default as MidCalc } from \"./def-hop-a.ts\";\n",
    )?;
    write_file(
        root,
        "lang/def-hop-c.ts",
        "export { MidCalc as default } from \"./def-hop-b.ts\";\n",
    )?;
    write_file(
        root,
        "lang/decorators.ts",
        concat!(
            "const decState = { cls: 2, fld: 2 };\n",
            "function recordDec(slot: \"cls\" | \"fld\", n: number) {\n",
            "  return function (_value: unknown, _ctx: unknown): void {\n",
            "    decState[slot] = n;\n",
            "  };\n",
            "}\n",
            "@recordDec(\"cls\", 2)\n",
            "export class DecoratedBox {\n",
            "  @recordDec(\"fld\", 2)\n",
            "  field = 1;\n",
            "}\n",
            "export const readDecState = (): string => `${decState.cls}:${decState.fld}`;\n",
        ),
    )?;
    write_file(
        root,
        "lang/tagged-tpl.ts",
        concat!(
            "const tplState = { v: 2 };\n",
            "function tag(strings: TemplateStringsArray, val: number): string {\n",
            "  tplState.v = val;\n",
            "  return `${strings[0]}${val}`;\n",
            "}\n",
            "export const unusedCss = tag`size:${2}`;\n",
            "export const readTplState = (): number => tplState.v;\n",
        ),
    )
}

fn write_ns_new_factory_diamond_fixtures(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "lang/ns-merge.ts",
        concat!(
            "export namespace CalcNs {\n",
            "  export const factor = 2;\n",
            "}\n",
            "export function mergedFn(x: number): number {\n",
            "  return x * mergedFn.mult;\n",
            "}\n",
            "export namespace mergedFn {\n",
            "  export const mult = 2;\n",
            "}\n",
            "export const enum ConstFactor {\n",
            "  Base = 2,\n",
            "}\n",
        ),
    )?;
    write_file(
        root,
        "lang/new-and-map.ts",
        concat!(
            "const ctorState = { custom: 2, mapVal: 2 };\n",
            "class SideEffectBox {\n",
            "  constructor(n: number) { ctorState.custom = n; }\n",
            "}\n",
            "function bumpMap(n: number): number {\n",
            "  ctorState.mapVal = n;\n",
            "  return n;\n",
            "}\n",
            "export const unusedCustom = new SideEffectBox(2);\n",
            "export const unusedMap = new Map<string, number>([[\"k\", bumpMap(2)]]);\n",
            "export const readNewState = (): string => `${ctorState.custom}:${ctorState.mapVal}`;\n",
        ),
    )?;
    write_file(
        root,
        "lang/pure-factory-clean.ts",
        concat!(
            "const z = { object: (shape: Record<string, unknown>) => shape };\n",
            "const createCtx = (val: number) => ({ val });\n",
            "export const unusedSchema = z.object({ a: 1 });\n",
            "export const unusedCtx = createCtx(1);\n",
            "export const readCleanPf = (): number => 2;\n",
        ),
    )?;
    write_file(
        root,
        "lang/pure-factory-trap.ts",
        concat!(
            "const pfState = { v: 2 };\n",
            "const z = { object: (shape: Record<string, unknown>) => shape };\n",
            "function bumpPf(n: number): number { pfState.v = n; return n; }\n",
            "export const trapSchema = z.object({ k: bumpPf(2) });\n",
            "export const readPfState = (): number => pfState.v;\n",
        ),
    )?;
    write_file(
        root,
        "lang/diamond-leaf.ts",
        "export const shared = 2;\nexport const leafOnly = 3;\n",
    )?;
    write_file(
        root,
        "lang/diamond-mid.ts",
        "export * from \"./diamond-leaf.ts\";\nexport const shared = 10;\n",
    )?;
    write_file(
        root,
        "lang/diamond-right.ts",
        "export { leafOnly } from \"./diamond-leaf.ts\";\n",
    )?;
    write_file(
        root,
        "lang/diamond-top.ts",
        "export * from \"./diamond-mid.ts\";\nexport * from \"./diamond-right.ts\";\n",
    )
}

fn write_lang_edge_tests(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "adv/lang-edge-reexport.test.ts",
        "import Bar from \"../lang/def-hop-c.ts\";\nif (Bar(3) !== 6) throw new Error(`def-hop=${Bar(3)}`);\n",
    )?;
    write_file(
        root,
        "adv/lang-edge-decorators.test.ts",
        "import { readDecState } from \"../lang/decorators.ts\";\nif (readDecState() !== \"2:2\") throw new Error(`dec=${readDecState()}`);\n",
    )?;
    write_file(
        root,
        "adv/lang-edge-tagged.test.ts",
        "import { readTplState } from \"../lang/tagged-tpl.ts\";\nif (readTplState() !== 2) throw new Error(`tpl=${readTplState()}`);\n",
    )?;
    write_file(
        root,
        "adv/lang-edge-ns.test.ts",
        "import { CalcNs, mergedFn, ConstFactor } from \"../lang/ns-merge.ts\";\nif (CalcNs.factor !== 2 || mergedFn(3) !== 6 || ConstFactor.Base !== 2) throw new Error(\"ns-merge\");\n",
    )?;
    write_file(
        root,
        "adv/lang-edge-new.test.ts",
        "import { readNewState } from \"../lang/new-and-map.ts\";\nif (readNewState() !== \"2:2\") throw new Error(`new=${readNewState()}`);\n",
    )?;
    write_file(
        root,
        "adv/lang-edge-pure-factory.test.ts",
        "import { readCleanPf } from \"../lang/pure-factory-clean.ts\";\nimport { readPfState } from \"../lang/pure-factory-trap.ts\";\nif (readCleanPf() !== 2 || readPfState() !== 2) throw new Error(`pf=${readCleanPf()}:${readPfState()}`);\n",
    )?;
    write_file(
        root,
        "adv/lang-edge-diamond-shadow.test.ts",
        "import { shared, leafOnly } from \"../lang/diamond-top.ts\";\nif (shared !== 10 || leafOnly !== 3) throw new Error(`diamond-shadow=${shared}:${leafOnly}`);\n",
    )?;
    write_file(
        root,
        "adv/lang-edge-diamond-leaf.test.ts",
        "import { shared } from \"../lang/diamond-leaf.ts\";\nif (shared !== 2) throw new Error(`diamond-leaf=${shared}`);\n",
    )
}

fn write_file(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let full = root.join(rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create dir {}: {error}", parent.display()))?;
    }
    fs::write(&full, content).map_err(|error| format!("write {rel}: {error}"))
}
