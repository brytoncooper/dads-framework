import assert from "node:assert/strict";
import test from "node:test";
import domino from "@mixmark-io/domino";
import { renderDocsCode } from "./docs-code.mjs";

test("renders language labels and syntax while preserving exact source text", () => {
  const source = `<!doctype html><html><body><article>
<h1 id="example">Example</h1>
<pre><code class="language-ts">
const markup = "&lt;button&gt;&amp;copy;&lt;/button&gt;";
  // Keep trailing spaces here${"  "}
</code></pre>
<pre><code class="language-sh">printf '%s\\n' "$HOME"
</code></pre>
<pre><code class="language-json">{"enabled": true}
</code></pre>
<pre><code class="language-neutral">a -&gt; b
</code></pre>
<pre><code class="language-unknown">&lt;untouched&gt;
</code></pre>
</article></body></html>`;
  const original = domino.createDocument(source);
  const rendered = domino.createDocument(renderDocsCode(source));
  const originalCode = Array.from(original.querySelectorAll("pre > code"));
  const examples = Array.from(rendered.querySelectorAll(".docs-example"));

  assert.ok(rendered.querySelector("h1#example"));
  assert.deepEqual(
    examples.map((example) => example.querySelector("code").textContent),
    originalCode.map((code) => code.textContent),
  );
  assert.deepEqual(
    examples.map(
      (example) => example.querySelector(".docs-example-language").textContent,
    ),
    ["TypeScript", "Shell", "JSON", "Plain text", "unknown"],
  );
  assert.deepEqual(
    examples.map((example) => Boolean(example.querySelector("code span"))),
    [true, true, true, false, false],
  );

  for (const example of examples) {
    const label = example.querySelector(".docs-example-language").textContent;
    const button = example.querySelector("button");
    assert.ok(button.hasAttribute("hidden"));
    assert.equal(button.getAttribute("aria-label"), `Copy ${label} code`);
    assert.equal(example.querySelector("pre").getAttribute("tabindex"), "0");
  }
});
