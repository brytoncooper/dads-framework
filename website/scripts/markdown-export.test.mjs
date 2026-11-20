import assert from "node:assert/strict";
import { test } from "node:test";
import { exportMarkdown } from "./markdown-export.mjs";

const origin = "https://dadsframework.dev";
const canonicals = new Map([
  ["/docs/index.html", "/docs/"],
  ["/docs/quickstart.html", "/docs/quickstart"],
]);

test("guide exports retain anchored prose, language, code whitespace and table cells", () => {
  const html = [
    '<main><section class="search">Search documentation</section>',
    '<article><h1 id="quickstart">Quickstart</h1>',
    '<details class="reader-outline"><summary>On this page</summary></details>',
    '<p>Read <a href="index.html#notes">the guide</a> or <a href="#setup">jump</a>.</p>',
    '<h2 id="setup">Setup</h2>',
    '<pre><code class="language-sh">npm create dads@latest my-app\ncd my-app\n</code></pre>',
    '<pre><code class="language-ts">\n  export type Flag = "on" | "off";\n\n</code></pre>',
    "<table><thead><tr><th>Option</th><th>Use</th></tr></thead>",
    "<tbody><tr><td><code>standard|strict</code></td><td>Pick a profile.</td></tr></tbody></table>",
    "<ol><li>Install dependencies.</li><li>Start PostgreSQL.</li></ol>",
    '</article><nav class="reader-pages">Next page</nav></main>',
  ].join("");
  const markdown = exportMarkdown(
    html,
    origin + "/docs/quickstart",
    canonicals,
  );

  assert.match(markdown, /<a id="quickstart"><\/a>\n\n# Quickstart/u);
  assert.match(
    markdown,
    /\[the guide\]\(https:\/\/dadsframework\.dev\/docs\/#notes\)/u,
  );
  assert.match(
    markdown,
    /\[jump\]\(https:\/\/dadsframework\.dev\/docs\/quickstart#setup\)/u,
  );
  assert.ok(
    markdown.includes("```sh\nnpm create dads@latest my-app\ncd my-app\n```"),
  );
  assert.ok(
    markdown.includes('```ts\n\n  export type Flag = "on" | "off";\n\n```'),
  );
  assert.ok(markdown.includes("| `standard\\|strict` | Pick a profile. |"));
  assert.match(markdown, /2\. +Start PostgreSQL\./u);
  assert.doesNotMatch(markdown, /Search documentation|On this page|Next page/u);
});

test("home retains all sections and a fallback table while dropping interactive controls", () => {
  const html = [
    '<main><h1>Framework</h1><div class="install"><code id="install-command">npm create dads@latest my-app</code></div>',
    '<div class="panel"><div class="panel-head"><span>Route</span><span>TypeScript</span></div>',
    "<pre><code>  listRoute({});</code></pre>",
    "<table><caption>Responses</caption><thead><tr><th>API</th><th>HTTP</th></tr></thead>",
    "<tbody><tr><th>Member</th><td>200 OK</td></tr><tr><th>Revoked</th><td>404</td></tr>",
    "<tr><th>Staff</th><td>404</td></tr></tbody></table>",
    '<form><button>Preview</button><input type="radio"></form></div>',
    "<section><article><h2>First card</h2></article><article><h2>Second card</h2></article></section></main>",
  ].join("");
  const markdown = exportMarkdown(html, origin + "/", canonicals);

  assert.ok(markdown.includes("```sh\nnpm create dads@latest my-app\n```"));
  assert.ok(markdown.includes("```ts\n  listRoute({});\n```"));
  assert.ok(markdown.includes("Responses\n\n| API | HTTP |"));
  for (const row of [
    "| Member | 200 OK |",
    "| Revoked | 404 |",
    "| Staff | 404 |",
  ]) {
    assert.ok(markdown.includes(row));
  }
  assert.match(markdown, /## First card[\s\S]*## Second card/u);
  assert.doesNotMatch(markdown, /Preview/u);
});

test("compact API companions retain a distinct link to original declarations", () => {
  const html =
    '<main><article><h1>UI API</h1></article><footer><span>Owner</span><a href="source/docs/site/reference/api-ui.md">Raw declaration report</a></footer></main>';
  const markdown = exportMarkdown(html, origin + "/docs/api-ui", canonicals);

  assert.match(
    markdown,
    /\[Full exported declarations \(raw Markdown\)\]\(https:\/\/dadsframework\.dev\/docs\/source\/docs\/site\/reference\/api-ui\.md\)/u,
  );
  assert.doesNotMatch(markdown, /Owner/u);
});
