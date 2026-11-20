import type { StarterProjectFile } from "./render-starter-project.js";

/** The starter checks the Git index using its installed TypeScript parser. */
export function renderStarterStagedChecks(): StarterProjectFile {
  return {
    path: "scripts/check-staged.mjs",
    content: String.raw`import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

function git(args, stdio = "pipe") {
  return execFileSync("git", args, { encoding: "utf8", stdio });
}

function checkTypeScript(path, source) {
  const result = ts.transpileModule(source, {
    fileName: path.replace(/\.d\.(ts|mts|cts)$/, ".$1"),
    compilerOptions: { target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.Preserve },
    reportDiagnostics: true,
  });
  const errors = result.diagnostics.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(path + ": " + ts.flattenDiagnosticMessageText(errors[0].messageText, "\n"));
  }
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  function checkNode(node) {
    if (node.kind === ts.SyntaxKind.DebuggerStatement ||
        node.kind === ts.SyntaxKind.AnyKeyword ||
        ts.isNonNullExpression(node)) {
      const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
      throw new Error(path + ":" + line + ": disallowed " + ts.SyntaxKind[node.kind]);
    }
    ts.forEachChild(node, checkNode);
  }
  checkNode(parsed);
}

git(["diff", "--cached", "--check"], "inherit");
const paths = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]);
const entries = git(["ls-files", "--stage", "-z"]).split("\0");
const regularFiles = new Set(
  entries.filter((entry) => /^100(?:644|755) [0-9a-f]+ 0\t/.test(entry))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
);
const stagedSource = paths.split("\0").filter(
  (path) => regularFiles.has(path) && /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx|rs)$/.test(path),
);
if (stagedSource.length > 0) {
  const snapshot = mkdtempSync(join(tmpdir(), "dads-starter-staged-"));
  try {
    const stagedConfiguration = ["dads.project.json", ".agents/source-budgets.json", "tsconfig.json"]
      .filter((path) => regularFiles.has(path));
    for (const path of [...stagedSource, ...stagedConfiguration]) {
      const source = git(["show", ":" + path]);
      if (/\.(?:ts|tsx|mts|cts)$/.test(path)) checkTypeScript(path, source);
      const target = join(snapshot, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    execFileSync(resolve("node_modules", ".bin", "dad"), [
      "doctor", snapshot, "--issue", "enmeshment",
      ...stagedSource.flatMap((path) => ["--file", "./" + path]),
    ], { stdio: "inherit" });
  } finally {
    rmSync(snapshot, { force: true, recursive: true });
  }
}
`,
  };
}
