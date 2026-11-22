import console from "node:console";
import process from "node:process";
import { createAgentIndexes } from "./agent-index.mjs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { renderDocsCode } from "./docs-code.mjs";
import { addDocsReader } from "./docs-reader.mjs";
import { exportMarkdown } from "./markdown-export.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "site");
const output = join(root, "dist");
const origin = "https://dadsframework.dev";
const repository = "https://github.com/brytoncooper/dads-framework";

function replaceRequired(text, marker, content, page) {
  if (!text.includes(marker))
    throw new Error(`Missing template marker ${marker} in ${page}.`);
  return text.replace(marker, () => content);
}

const themeInitScript = `<script src="/assets/theme-init.js"></script>`;

const themeToggleButton = `<button type="button" class="theme-toggle" data-theme-toggle aria-label="Switch to light mode" title="Switch to light mode" aria-pressed="false">
      <svg class="theme-icon theme-icon-sun" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="3.5"/><path d="M10 2.2v1.8M10 16v1.8M2.2 10H4M16 10h1.8M4.5 4.5l1.3 1.3M14.2 14.2l1.3 1.3M15.5 4.5l-1.3 1.3M5.8 14.2l-1.3 1.3"/></svg>
      <svg class="theme-icon theme-icon-moon" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.8 12.6A6.5 6.5 0 0 1 7.4 4.2a6.5 6.5 0 1 0 8.4 8.4Z"/></svg>
    </button>`;

const docsSearchTrigger = `<button type="button" class="header-search-trigger" id="docs-search-trigger" aria-haspopup="dialog" aria-controls="docs-search-dialog" aria-label="Search documentation">
      <svg class="header-search-icon" viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="8.75" cy="8.75" r="5.75"/><path d="M13 13l4.25 4.25" stroke-linecap="round"/></svg>
      <span class="header-search-label">Search</span>
      <kbd class="header-search-shortcut" aria-hidden="true">⌘K</kbd>
    </button>`;

export function siteHeader(currentPage) {
  const searchButton =
    currentPage === "docs" ? `\n    ${docsSearchTrigger}` : "";
  return `<header class="site-header"><div class="wrap">
  <a href="/" class="brand"${currentPage === "home" ? ' aria-current="page"' : ""}><img src="/assets/dads-symbol-light.png" class="brand-symbol brand-symbol-on-dark" alt="" width="26" height="26"><img src="/assets/dads-symbol-dark.png" class="brand-symbol brand-symbol-on-light" alt="" width="26" height="26">Dads Framework</a>
  <nav aria-label="Main">${searchButton}
    <a href="/docs/"${currentPage === "docs" ? ' aria-current="page"' : ""}>Docs</a>
    <a href="${repository}">GitHub <span aria-hidden="true">↗</span></a>
    ${themeToggleButton}
  </nav>
</div></header>`;
}

const siteFooter = (
  markdownPath,
) => `<footer class="site-footer"><div class="wrap">
  <small>Dads Framework · <a href="/framework-license.txt">MIT license</a></small>
  <small><a href="${markdownPath}" type="text/markdown">Read as Markdown</a> · <a href="/docs/llms.txt">llms.txt</a> · <a href="/credits.html">Credits</a></small>
</div></footer>`;

function canonicalPath(path) {
  if (path === "index.html") return "/";
  if (path === "docs/index.html") return "/docs/";
  if (path.startsWith("docs/")) return `/${path.slice(0, -5)}`;
  return `/${path}`;
}

function markdownPath(path) {
  return `/${path.slice(0, -5)}.md`;
}

function markdownAlternate(html, path) {
  return replaceRequired(
    html,
    "</head>",
    `<link rel="alternate" type="text/markdown" href="${markdownPath(path)}">
</head>`,
    path,
  );
}

export function renderDocs(html, page) {
  html = addDocsReader(html, page);
  const file = `docs/${page}`;
  const path = canonicalPath(file);
  html = replaceRequired(
    html,
    '<link rel="stylesheet" href="assets/site.css">',
    "",
    page,
  );
  html = replaceRequired(
    html,
    "</head>",
    `<meta name="theme-color" content="#0e1114">
<link rel="canonical" href="${origin}${path}">
<link rel="icon" href="/assets/dads-favicon.png" type="image/png">
${themeInitScript}
<link rel="stylesheet" href="/assets/base.css">
<link rel="stylesheet" href="/assets/docs.css">
<noscript><style>.header-search-trigger{display:none}</style></noscript>
<noscript><style>.theme-toggle{display:none}</style></noscript>
<script src="/assets/theme.js" defer></script>
<script type="module" src="/assets/docs.js"></script>
</head>`,
    page,
  );
  html = replaceRequired(
    html,
    '<header><a href="index.html">Dads documentation</a><a href="llms.txt">llms.txt</a></header>',
    siteHeader("docs"),
    page,
  );
  html = replaceRequired(
    html,
    '<nav aria-label="Documentation">',
    '<details class="docs-menu" open><summary>Browse documentation</summary><nav aria-label="Documentation">',
    page,
  );
  html = replaceRequired(
    html,
    "</nav>\n<main",
    "</nav></details>\n<main",
    page,
  );
  html = html.replace(
    ">Markdown source</a>",
    page.startsWith("api-")
      ? ">Raw declaration report</a>"
      : ">Original Markdown source</a>",
  );
  html = replaceRequired(
    html,
    "</body>",
    `${siteFooter(markdownPath(file))}
</body>`,
    page,
  );
  return markdownAlternate(html, file);
}

async function buildSite() {
  const docsArg = process.argv[2] || process.env.DADS_DOCS_DIR;
  if (!docsArg)
    throw new Error(
      "Pass the generated docs folder to npm run build -- <docs-folder>.",
    );
  const docs = resolve(docsArg);
  const outputRelativeDocs = relative(output, docs);
  if (
    docs === output ||
    (!outputRelativeDocs.startsWith("..") && !isAbsolute(outputRelativeDocs))
  ) {
    throw new Error("The input docs must live outside the output folder.");
  }

  const required = [
    "index.html",
    "search-index.js",
    "assets/search.js",
    "assets/site.css",
    "source",
    "llms.txt",
  ];
  await Promise.all(required.map((path) => stat(join(docs, path))));
  const pages = (await readdir(docs))
    .filter((file) => file.endsWith(".html"))
    .sort();

  const renderedPages = await Promise.all(
    pages.map(async (page) => [
      page,
      renderDocs(await readFile(join(docs, page), "utf8"), page),
    ]),
  );
  const storyLink = (title, fallback) => {
    const matched = renderedPages.find(([, html]) => {
      const heading = html.match(/<article><h1[^>]*>([^<]*)<\/h1>/u)?.[1];
      return heading?.trim().toLowerCase() === title.toLowerCase();
    });
    return matched
      ? `/docs/${matched[0]}`
      : `${repository}/blob/main/${fallback}`;
  };

  let home = await readFile(join(source, "index.html"), "utf8");
  home = replaceRequired(
    home,
    "<!-- site-header -->",
    siteHeader("home"),
    "home",
  );
  home = replaceRequired(
    home,
    "<!-- site-footer -->",
    siteFooter(markdownPath("index.html")),
    "home",
  );
  home = replaceRequired(
    home,
    "<!-- dad-url -->",
    storyLink("Dad", "DAD.md"),
    "home",
  );
  home = replaceRequired(
    home,
    "<!-- gary-url -->",
    storyLink("Who let Gary back in?", "docs/go-ask-your-other-database.md"),
    "home",
  );
  const supportingPages = await Promise.all(
    ["credits.html", "404.html"].map(async (page) => {
      let html = await readFile(join(source, page), "utf8");
      html = replaceRequired(
        html,
        "<!-- site-header -->",
        siteHeader(""),
        page,
      );
      html = replaceRequired(
        html,
        "<!-- site-footer -->",
        siteFooter(markdownPath(page)),
        page,
      );
      return [page, markdownAlternate(html, page)];
    }),
  );

  const sitePages = [
    ["index.html", markdownAlternate(home, "index.html")],
    ...supportingPages,
    ...renderedPages.map(([page, html]) => [`docs/${page}`, html]),
  ];
  const canonicalPaths = new Map(
    sitePages.map(([path]) => [`/${path}`, canonicalPath(path)]),
  );
  const { rootIndex, docsIndex } = createAgentIndexes({
    origin,
    renderedPages,
  });
  const companions = sitePages.map(([path, html]) => [
    markdownPath(path).slice(1),
    exportMarkdown(html, `${origin}${canonicalPath(path)}`, canonicalPaths),
  ]);

  await rm(output, { recursive: true, force: true });
  await mkdir(output);
  const retiredAssets = new Set([
    "dads.png",
    "house-key.webp",
    "serif.woff2",
    "serif-italic.woff2",
    "OFL-Instrument-Serif.txt",
  ]);
  await cp(source, output, {
    recursive: true,
    filter: (path) =>
      !retiredAssets.has(relative(join(source, "assets"), path)),
  });
  await cp(docs, join(output, "docs"), { recursive: true });
  await Promise.all([
    writeFile(join(output, "llms.txt"), rootIndex),
    writeFile(join(output, "docs", "llms.txt"), docsIndex),
    ...[...sitePages, ...companions].map(([file, content]) =>
      writeFile(
        join(output, file),
        file.startsWith("docs/") && file.endsWith(".html")
          ? renderDocsCode(content)
          : content,
      ),
    ),
    writeFile(
      join(output, "sitemap.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${["/", ...pages.map((page) => (page === "index.html" ? "/docs/" : `/docs/${page.slice(0, -5)}`))].map((path) => `  <url><loc>https://dadsframework.dev${path}</loc></url>`).join("\n")}\n</urlset>\n`,
    ),
  ]);
  console.log(
    `Built landing page and ${pages.length} documentation pages in dist/.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await buildSite();
}
