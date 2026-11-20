import { Marked, Renderer } from "marked";

import { markdownLink } from "./site-links.mjs";

const HTML_CHARS = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
]);

function escape(value) {
  return value.replace(/[&<>"']/g, (character) => HTML_CHARS.get(character));
}

function anchor(text, counts) {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .replace(/ +/g, "-");
  const used = counts.get(slug) ?? 0;
  counts.set(slug, used + 1);
  return used === 0 ? slug : `${slug}-${String(used)}`;
}

function renderMarkdown(markdown, link) {
  const counts = new Map();
  const renderer = new Renderer();
  renderer.html = (token) =>
    token.text.trimStart().startsWith("<!--") ? "" : escape(token.text);
  renderer.heading = function (token) {
    const id = anchor(token.text, counts);
    return `<h${token.depth} id="${escape(id)}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
  };
  const parser = new Marked({ renderer });
  parser.use({
    walkTokens(token) {
      if (token.type === "link" || token.type === "image")
        token.href = link(token.href);
    },
  });
  return parser.parse(markdown);
}

function navigation(pages, current) {
  const grouped = Map.groupBy(pages, (page) => page.section);
  return [...grouped]
    .map(([section, entries]) => {
      const links = entries.map((page) => {
        const active = page.slug === current.slug ? ' aria-current="page"' : "";
        return `<li><a href="${page.slug}.html"${active}>${escape(page.title)}</a></li>`;
      });
      return `<h2>${escape(section)}</h2><ul>${links.join("")}</ul>`;
    })
    .join("");
}

export function renderPage({ root, page, pages, byPath, files }) {
  const article = renderMarkdown(page.markdown, (target) =>
    markdownLink({ root, pages: byPath, files, source: page.path, target }),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.title)} · Dads documentation</title>
<link rel="stylesheet" href="assets/site.css">
<script defer src="search-index.js"></script>
<script defer src="assets/search.js"></script>
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<header><a href="index.html">Dads documentation</a><a href="llms.txt">llms.txt</a></header>
<div class="layout">
<nav aria-label="Documentation">${navigation(pages, page)}</nav>
<main id="content" tabindex="-1">
<section class="search" role="search">
<label for="docs-search">Search documentation</label>
<input id="docs-search" type="search" autocomplete="off" placeholder="Try permissions or migration">
<p id="search-status" aria-live="polite"></p>
<ul id="search-results"></ul>
</section>
<article>${article}</article>
<footer><span>Owner <code>${escape(page.owner)}</code></span><a href="source/${escape(page.path)}">Markdown source</a></footer>
</main>
</div>
</body>
</html>
`;
}
