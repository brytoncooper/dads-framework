import domino from "@mixmark-io/domino";
import highlighter from "highlight.js";

const labels = new Map([
  ["bash", "Shell"],
  ["css", "CSS"],
  ["html", "HTML"],
  ["http", "HTTP"],
  ["javascript", "JavaScript"],
  ["json", "JSON"],
  ["plaintext", "Plain text"],
  ["powershell", "PowerShell"],
  ["sql", "SQL"],
  ["typescript", "TypeScript"],
]);

const aliases = new Map([
  ["sh", "bash"],
  ["shell", "bash"],
  ["zsh", "bash"],
  ["text", "plaintext"],
  ["neutral", "plaintext"],
]);

export function renderDocsCode(html) {
  const document = domino.createDocument(html);
  const blocks = document.querySelectorAll("article pre > code");
  if (!blocks.length) return html;

  for (const code of blocks) {
    const language = Array.from(code.classList)
      .find((className) => className.startsWith("language-"))
      ?.slice("language-".length)
      .toLowerCase();
    const syntax = aliases.get(language) ?? language;
    const grammar = syntax && highlighter.getLanguage(syntax);
    const label =
      labels.get(grammar?.name?.toLowerCase()) ??
      labels.get(syntax) ??
      grammar?.name ??
      language ??
      "Plain text";
    if (grammar && syntax !== "plaintext") {
      code.innerHTML = highlighter.highlight(code.textContent, {
        language: syntax,
        ignoreIllegals: true,
      }).value;
    }

    const block = code.parentNode;
    const wrapper = document.createElement("div");
    wrapper.className = "docs-example";
    wrapper.innerHTML = `<div class="docs-example-controls">
  <span class="docs-example-language"></span>
  <button type="button" hidden>Copy</button>
  <span class="sr" role="status"></span>
</div>`;
    wrapper.querySelector(".docs-example-language").textContent = label;
    wrapper
      .querySelector("button")
      .setAttribute("aria-label", `Copy ${label} code`);
    block.setAttribute("role", "region");
    block.setAttribute("aria-label", `${label} code`);
    block.setAttribute("tabindex", "0");
    block.parentNode.replaceChild(wrapper, block);
    wrapper.appendChild(block);
  }
  return document.outerHTML;
}
