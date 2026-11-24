import assert from "node:assert/strict";
import test from "node:test";
import { renderDocsCode } from "./docs-code.mjs";

test("renders mermaid blocks as CSP-safe inline SVGs with unique marker ids", () => {
  const html = `<!doctype html><html><body><article>
    <h2>Dependency flow</h2>
    <pre><code class="language-mermaid">flowchart TD
  a["App"] --&gt; b["Core"]
</code></pre>
    <h2>Second graph</h2>
    <pre><code class="language-mermaid">flowchart LR
  x["One"] --&gt; y["Two"]
</code></pre>
  </article></body></html>`;

  const rendered = renderDocsCode(html);

  assert.match(rendered, /<figure class="docs-diagram">/u);
  assert.match(rendered, /<svg role="img" aria-label="Dependency flow diagram"/u);
  assert.match(rendered, /<svg role="img" aria-label="Second graph diagram"/u);
  assert.match(rendered, /id="mermaid-0-arrowhead"/u);
  assert.match(rendered, /id="mermaid-1-arrowhead"/u);
  assert.equal(rendered.includes("<style"), false, "SVG must not emit inline <style> tags under strict CSP");
  assert.equal(/\sstyle="/u.test(rendered), false, "SVG must not emit inline style attributes under strict CSP");
  assert.match(rendered, /<details class="docs-diagram-source">/u);
});
