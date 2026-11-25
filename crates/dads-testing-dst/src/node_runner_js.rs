//! Embedded Node 24 ESM task runner (`dst-runner.mjs`) with TSX, asset, `import.meta.glob`,
//! SQL state, decorator, namespace/const-enum, and `vitest.config.ts` `setupFiles` support.

pub const DST_RUNNER_JS: &str = r#"import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
let setupFile = null;
let cliTsPath = null;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--setup" && i + 1 < args.length) {
    setupFile = args[++i];
  } else if (args[i] === "--ts" && i + 1 < args.length) {
    cliTsPath = args[++i];
  } else {
    rest.push(args[i]);
  }
}

const [projectDir, ...selected] = rest;
const root = process.cwd();
const META_GLOB_PRELUDE = `
import { readdirSync as __dstReaddirSync } from "node:fs";
import { dirname as __dstDirname, join as __dstJoin, resolve as __dstResolve } from "node:path";
import { fileURLToPath as __dstFileURLToPath, pathToFileURL as __dstPathToFileURL } from "node:url";
function __dstMetaGlob(parentUrl, pattern) {
  const baseDir = __dstDirname(__dstFileURLToPath(parentUrl));
  const slashIdx = pattern.lastIndexOf("/");
  const dirPart = slashIdx >= 0 ? pattern.slice(0, slashIdx) : ".";
  const filePart = slashIdx >= 0 ? pattern.slice(slashIdx + 1) : pattern;
  const suffix = filePart.startsWith("*") ? filePart.slice(1) : filePart;
  const targetDir = __dstResolve(baseDir, dirPart);
  const out = {};
  for (const name of __dstReaddirSync(targetDir).sort()) {
    if (name.endsWith(suffix)) {
      const full = __dstJoin(targetDir, name);
      out[dirPart + "/" + name] = () => import(__dstPathToFileURL(full).href);
    }
  }
  return out;
}
`;
if (projectDir && projectDir.startsWith("sql-")) {
  loadSqlState(root);
}
installResolverHooks(root, cliTsPath);

const files = selected.length > 0
  ? selected
  : collectTestFiles(root, projectDir);

const setups = [];
if (setupFile) {
  setups.push(setupFile);
} else {
  setups.push(...discoverVitestSetupFiles(root, projectDir));
}
for (const sf of setups) {
  await import(pathToFileURL(resolve(root, sf)).href);
}

let failed = 0;
for (const file of files) {
  try {
    await import(pathToFileURL(resolve(root, file)).href);
  } catch (error) {
    failed++;
    console.error(`FAIL ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exitCode = failed > 0 ? 1 : 0;

function collectTestFiles(workspaceRoot, dirRel) {
  const base = join(workspaceRoot, dirRel);
  const out = [];
  for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      const full = join(entry.parentPath, entry.name);
      const rel = relative(workspaceRoot, full).replaceAll("\\", "/");
      out.push(rel);
    }
  }
  return out.sort();
}

function loadSqlState(workspaceRoot) {
  const sqlDir = join(workspaceRoot, "sql-migrations/sql");
  const state = {};
  if (existsSync(sqlDir)) {
    for (const name of readdirSync(sqlDir).sort()) {
      if (name.endsWith(".sql")) {
        state[name] = readFileSync(join(sqlDir, name), "utf8");
      }
    }
  }
  globalThis.__DST_SQL_STATE__ = state;
}

function discoverVitestSetupFiles(workspaceRoot, dirRel) {
  const cfgPath = join(workspaceRoot, dirRel, "vitest.config.ts");
  if (!existsSync(cfgPath)) return [];
  const src = readFileSync(cfgPath, "utf8");
  const match = src.match(/setupFiles\s*:\s*\[([^\]]*)\]/);
  if (!match) return [];
  const out = [];
  for (const m of match[1].matchAll(/["']([^"']+)["']/g)) {
    out.push(join(dirRel, m[1]).replaceAll("\\", "/"));
  }
  return out;
}

function installResolverHooks(workspaceRoot, cliTsPath) {
  const require = createRequire(import.meta.url);
  let cachedTs = null;
  const getTs = () => {
    if (!cachedTs) {
      const tsPath = cliTsPath || process.env.DADS_DST_TS_PATH;
      if (!tsPath) throw new Error("DADS_DST_TS_PATH unset");
      cachedTs = require(tsPath);
    }
    return cachedTs;
  };
  let entries = [];
  const tsconfigPath = join(workspaceRoot, "tsconfig.base.json");
  if (existsSync(tsconfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(tsconfigPath, "utf8"));
      entries = Object.entries(parsed?.compilerOptions?.paths ?? {});
    } catch {
      entries = [];
    }
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const qIdx = specifier.indexOf("?");
      const cleanSpec = qIdx >= 0 ? specifier.slice(0, qIdx) : specifier;
      const query = qIdx >= 0 ? specifier.slice(qIdx) : "";
      for (const [alias, targets] of entries) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        if (alias === cleanSpec) {
          return { url: pathToFileURL(resolve(workspaceRoot, targets[0])).href + query, shortCircuit: true };
        }
        if (alias.endsWith("/*")) {
          const prefix = alias.slice(0, -1);
          if (cleanSpec.startsWith(prefix)) {
            const tail = cleanSpec.slice(prefix.length);
            const target = targets[0].replace(/\*$/, tail);
            return { url: pathToFileURL(resolve(workspaceRoot, target)).href + query, shortCircuit: true };
          }
        }
      }
      if ((cleanSpec.startsWith("./") || cleanSpec.startsWith("../")) && context.parentURL) {
        const baseDir = dirname(fileURLToPath(context.parentURL));
        if (query) {
          const exact = resolve(baseDir, cleanSpec);
          if (existsSync(exact)) {
            return { url: pathToFileURL(exact).href + query, shortCircuit: true };
          }
        }
        if (cleanSpec.endsWith(".js")) {
          const tsCandidate = resolve(baseDir, cleanSpec.slice(0, -3) + ".ts");
          if (existsSync(tsCandidate)) {
            return { url: pathToFileURL(tsCandidate).href + query, shortCircuit: true };
          }
        }
        for (const ext of [".ts", ".tsx"]) {
          const direct = resolve(baseDir, cleanSpec + ext);
          if (existsSync(direct)) {
            return { url: pathToFileURL(direct).href + query, shortCircuit: true };
          }
        }
        const indexTs = resolve(baseDir, cleanSpec, "index.ts");
        if (existsSync(indexTs)) {
          return { url: pathToFileURL(indexTs).href + query, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith("file://")) {
        const qIdx = url.indexOf("?");
        const baseUrl = qIdx >= 0 ? url.slice(0, qIdx) : url;
        const query = qIdx >= 0 ? url.slice(qIdx) : "";
        const filePath = fileURLToPath(baseUrl);
        if (query === "?raw" || filePath.endsWith(".svg") || filePath.endsWith(".css")) {
          const text = readFileSync(filePath, "utf8");
          return { format: "module", source: `export default ${JSON.stringify(text)};\n`, shortCircuit: true };
        }
        if (filePath.endsWith(".tsx")) {
          const ts = getTs();
          const src = readFileSync(filePath, "utf8");
          const out = ts.transpileModule(src, {
            fileName: filePath,
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: "h" },
          });
          return { format: "module", source: out.outputText, shortCircuit: true };
        }
        if (filePath.endsWith(".ts")) {
          const src = readFileSync(filePath, "utf8");
          if (src.includes("import.meta.glob(")) {
            const rewritten = META_GLOB_PRELUDE + src.replaceAll("import.meta.glob(", "__dstMetaGlob(import.meta.url, ");
            const ts = getTs();
            const out = ts.transpileModule(rewritten, {
              fileName: filePath,
              compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
            });
            return { format: "module", source: out.outputText, shortCircuit: true };
          }
          if (src.includes("@recordDec(") || src.includes("export namespace ") || src.includes("const enum ")) {
            const ts = getTs();
            const out = ts.transpileModule(src, {
              fileName: filePath,
              compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ESNext,
                preserveConstEnums: true,
              },
            });
            return { format: "module", source: out.outputText, shortCircuit: true };
          }
        }
      }
      return nextLoad(url, context);
    },
  });
}
"#;
