import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

import { checkPackageExamples } from "./package-examples.mjs";
import { loadSiteCatalog } from "./site-catalog.mjs";
import { checkExamples, loadPageExamples } from "./site-examples.mjs";
import { expandPageExamples } from "./site-excerpt.mjs";
import { exampleFileReader } from "./site-links.mjs";
import { renderPage } from "./site-render.mjs";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const ASSETS = ["search.js", "site.css"];

function createSite(root) {
  const files = new Map();
  const readExampleFile = exampleFileReader(root, files);
  const pages = loadSiteCatalog(root).map((page) => {
    loadPageExamples(page, readExampleFile);
    return { ...page, markdown: expandPageExamples(page, readExampleFile) };
  });
  const byPath = new Map(pages.map((page) => [page.path, page]));
  for (const page of pages) {
    files.set(`source/${page.path}`, page.sourceMarkdown ?? page.markdown);
    files.set(
      `${page.slug}.html`,
      renderPage({ root, page, pages, byPath, files }),
    );
  }
  const index = pages.map(({ slug, title, markdown }) => ({
    path: `${slug}.html`,
    title,
    text: markdown,
  }));
  files.set(
    "search-index.js",
    `globalThis.dadsDocsSearch = ${JSON.stringify(index)};\n`,
  );
  files.set("llms.txt", agentIndex(pages));
  for (const asset of ASSETS) {
    files.set(
      `assets/${asset}`,
      readFileSync(join(root, "scripts/docs/assets", asset)),
    );
  }
  return { pages, files };
}

function agentIndex(pages) {
  const lines = [
    "# Dads documentation",
    "",
    "> Guides and API reports for the current workspace.",
  ];
  for (const [section, entries] of Map.groupBy(pages, (page) => page.section)) {
    lines.push("", `## ${section}`, "");
    lines.push(
      ...entries.map(
        (page) => `- [${page.title}](source/${page.path}) — ${page.owner}`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function checkDocsSite(root) {
  execFileSync(
    process.execPath,
    ["scripts/build/sync-kit-starter.mjs", "--check"],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  const { pages } = createSite(root);
  const tests = checkExamples(root, pages);
  const readmes = checkPackageExamples(root);
  return `docs health: ${String(pages.length)} pages, ${String(tests)} compiled and executed example suites, ${String(readmes.packages)} package READMEs and ${String(readmes.snippets)} typechecked README examples\n`;
}

function writeDocsSite(root) {
  const { pages, files } = createSite(root);
  const output = join(root, "dist", "dads-docs");
  rmSync(output, { recursive: true, force: true });
  for (const [path, content] of files) {
    const target = join(output, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return `Built ${String(pages.length)} pages at ${join(output, "index.html")}\n`;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const command = process.argv[2];
  if (command === "--check") process.stdout.write(checkDocsSite(rootDirectory));
  else if (command === undefined)
    process.stdout.write(writeDocsSite(rootDirectory));
  else throw new Error("Usage: node scripts/docs/site-build.mjs [--check]");
}
