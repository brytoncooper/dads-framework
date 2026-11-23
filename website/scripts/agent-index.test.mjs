import assert from "node:assert/strict";
import test from "node:test";

import { createAgentIndexes } from "./agent-index.mjs";

const navigation = `<nav aria-label="Documentation">
<h2>Get started</h2><ul><li><a href="index.html" aria-current="page">Why Dads</a></li><li><a href="quickstart.html">Quickstart</a></li></ul>
<h2>Operate &amp; verify</h2><ul><li><a href="verification.html">Tests &amp; [checks]</a></li></ul>
<h2>API reference</h2><ul><li><a href="api.html">API reference</a></li><li><a href="api-http.html">@dads-framework/http</a></li></ul>
</nav>`;

const renderedPages = [
  ["api-http.html", '<a href="source/docs/site/reference/api-http.md">Markdown source</a>'],
  ["api.html", "<h1>API reference</h1>"],
  ["index.html", navigation],
  ["quickstart.html", "<h1>Quickstart</h1>"],
  ["verification.html", "<h1>Tests &amp; [checks]</h1>"],
];

test("indexes every page in reader navigation order with full Markdown URLs", () => {
  const { rootIndex, docsIndex } = createAgentIndexes({
    origin: "https://dadsframework.dev/",
    renderedPages,
  });
  for (const index of [rootIndex, docsIndex]) {
    assert.match(index, /\[Why Dads\]\(https:\/\/dadsframework\.dev\/docs\/index\.md\)/u);
    assert.match(index, /\[Quickstart\]\(https:\/\/dadsframework\.dev\/docs\/quickstart\.md\)/u);
    assert.match(index, /## Operate & verify/u);
    assert.ok(index.includes("[Tests & \\[checks\\]]"));
    assert.match(index, /\[API reference\]\(https:\/\/dadsframework\.dev\/docs\/api\.md\)/u);
    assert.match(
      index,
      /\[Raw API declarations\]\(https:\/\/dadsframework\.dev\/docs\/source\/docs\/site\/reference\/api-http\.md\)/u,
    );
    assert.match(index, /\[Dads Framework\]\(https:\/\/dadsframework\.dev\/index\.md\)/u);
    assert.match(index, /\[Credits\]\(https:\/\/dadsframework\.dev\/credits\.md\)/u);
    assert.ok(index.indexOf("Why Dads") < index.indexOf("Quickstart"));
    assert.ok(!index.includes("404"));
  }
  assert.ok(rootIndex.indexOf("## Site") < rootIndex.indexOf("## Get started"));
  assert.ok(docsIndex.indexOf("## Site") > docsIndex.indexOf("## API reference"));
});

test("rejects missing public pages, missing raw declarations, and stale navigation", () => {
  const build = (pages) => createAgentIndexes({ renderedPages: pages });
  assert.throws(() => build([...renderedPages, ["invisible.html", ""]]), /missing from navigation: invisible.html/u);
  assert.throws(
    () => build(renderedPages.map(([name, html]) => [name, name === "api-http.html" ? "" : html])),
    /Missing raw API reference link for api-http.html/u,
  );
  assert.throws(
    () => build(renderedPages.filter(([name]) => name !== "quickstart.html")),
    /Invalid documentation navigation entry: quickstart.html/u,
  );
});

test("indexes package examples from the lookup page", () => {
  const lookup = `<article class="package-index"><h1>Packages</h1>
<ul><li><a href="package-http.html#try-it">@dads-framework/http</a></li></ul></article>`;
  const pages = [
    ...renderedPages.map(([name, html]) => [
      name,
      name === "index.html"
        ? html.replace("</nav>", '<h2>Reference</h2><ul><li><a href="packages.html">Packages</a></li></ul></nav>')
        : html,
    ]),
    ["packages.html", lookup],
    ["package-http.html", '<article><h1>HTTP</h1><h2 id="try-it">Try it</h2></article>'],
  ];
  const { rootIndex, docsIndex } = createAgentIndexes({ renderedPages: pages });
  for (const index of [rootIndex, docsIndex]) {
    assert.match(index, /\[Packages\]\(https:\/\/dadsframework\.dev\/docs\/packages\.md\)/u);
    assert.match(index, /\[@dads-framework\/http\]\(https:\/\/dadsframework\.dev\/docs\/package-http\.md#try-it\)/u);
  }
  assert.throws(
    () => createAgentIndexes({ renderedPages: pages.slice(0, -1) }),
    /Invalid documentation package example: package-http.html/u,
  );
});
