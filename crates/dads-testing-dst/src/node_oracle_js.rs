//! Embedded persistent Node 24 V8 oracle worker script (paired with `node_runner_js.rs`).

pub const PERSISTENT_ORACLE_JS: &str = r#"import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";

const WORKER_SCRIPT = `
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

const { workspaceRoot, testFile, setupFile, tsPath } = workerData;
const require = createRequire(import.meta.url);
let cachedTs = null;
const getTs = () => {
  if (!cachedTs) cachedTs = require(tsPath);
  return cachedTs;
};

const sqlDir = join(workspaceRoot, "sql-migrations/sql");
const sqlState = {};
if (existsSync(sqlDir)) {
  for (const name of readdirSync(sqlDir).sort()) {
    if (name.endsWith(".sql")) sqlState[name] = readFileSync(join(sqlDir, name), "utf8");
  }
}
globalThis.__DST_SQL_STATE__ = sqlState;

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

const META_GLOB_PRELUDE = \`
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
\`;

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
          const target = targets[0].replace(/\\*$/, tail);
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
        return { format: "module", source: "export default " + JSON.stringify(text) + ";\\n", shortCircuit: true };
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

function discoverVitestSetups() {
  const dirRel = testFile.split("/")[0];
  const cfgPath = join(workspaceRoot, dirRel, "vitest.config.ts");
  if (!existsSync(cfgPath)) return [];
  const src = readFileSync(cfgPath, "utf8");
  const match = src.match(/setupFiles\\s*:\\s*\\[([^\\]]*)\\]/);
  if (!match) return [];
  const out = [];
  for (const m of match[1].matchAll(/["']([^"']+)["']/g)) {
    out.push(join(dirRel, m[1]).replaceAll("\\\\", "/"));
  }
  return out;
}

try {
  const setups = setupFile ? [setupFile] : discoverVitestSetups();
  for (const sf of setups) {
    await import(pathToFileURL(resolve(workspaceRoot, sf)).href);
  }
  await import(pathToFileURL(resolve(workspaceRoot, testFile)).href);
  parentPort.postMessage({ ok: true, error: null });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
`;

const tsPath = process.env.DADS_DST_TS_PATH ?? "";

function runOne(workspaceRoot, testFile, setupFile, extraEnv) {
  return new Promise((resolvePromise) => {
    const worker = new Worker(WORKER_SCRIPT, {
      eval: true,
      execArgv: ["--no-warnings", "--experimental-transform-types"],
      env: { ...process.env, ...(extraEnv ?? {}) },
      workerData: { workspaceRoot, testFile, setupFile, tsPath },
    });
    let settled = false;
    worker.once("message", (msg) => {
      settled = true;
      worker.terminate().catch(() => {});
      resolvePromise(msg);
    });
    worker.once("error", (err) => {
      if (!settled) {
        settled = true;
        worker.terminate().catch(() => {});
        resolvePromise({ ok: false, error: err.message });
      }
    });
    worker.once("exit", (code) => {
      if (!settled) {
        settled = true;
        resolvePromise({ ok: code === 0, error: code === 0 ? null : `worker exit ${code}` });
      }
    });
  });
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    const entries = await mapLimited(req.tests, 4, async (item) => {
      const res = await runOne(req.workspaceRoot, item.file, item.setupFile ?? null, item.env ?? null);
      return [item.file, res];
    });
    const results = Object.fromEntries(entries);
    process.stdout.write(JSON.stringify({ ok: true, results }) + "\n");
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n",
    );
  }
});
"#;
