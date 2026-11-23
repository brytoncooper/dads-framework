import { URL } from "node:url";
import domino from "@mixmark-io/domino";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const CHROME = [
  "nav",
  "footer",
  "form",
  "button",
  "script",
  "style",
  "[hidden]",
  '[aria-hidden="true"]',
  ".sr",
  ".search",
  ".reader-outline",
  ".panel-head",
].join(", ");

function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function normalizeUrl(target, pageUrl, canonicalPaths) {
  const url = new URL(target, pageUrl);
  if (url.origin === pageUrl.origin) {
    url.pathname = canonicalPaths.get(url.pathname) ?? url.pathname;
  }
  return url.href;
}

function labelHomepageCode(content, document) {
  const install = content.querySelector(".install");
  const command = install?.querySelector("#install-command");
  if (command) {
    const block = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-sh";
    code.textContent = command.textContent;
    block.appendChild(code);
    install.parentNode.replaceChild(block, install);
  }
  for (const panel of Array.from(content.querySelectorAll(".panel"))) {
    const language = panel.querySelector(".panel-head span:last-child");
    const code = panel.querySelector("pre > code");
    if (language?.textContent.trim() === "TypeScript" && code) {
      code.classList.add("language-ts");
    }
  }
}

function makeLinksAbsolute(content, pageUrl, canonicalPaths) {
  for (const link of Array.from(content.querySelectorAll("a[href], img[src]"))) {
    const attribute = link.tagName === "A" ? "href" : "src";
    const target = link.getAttribute(attribute);
    link.setAttribute(attribute, normalizeUrl(target, pageUrl, canonicalPaths));
  }
}

function preserveCaptions(content, document) {
  for (const caption of Array.from(content.querySelectorAll("table > caption"))) {
    const table = caption.parentNode;
    const label = document.createElement("p");
    label.innerHTML = caption.innerHTML;
    table.parentNode.insertBefore(label, table);
    caption.remove();
  }
}

function addExportRules(converter) {
  converter.use(gfm);
  converter.addRule("stableHeadings", {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement(content, node) {
      const id = node.getAttribute("id");
      const anchor = id ? `<a id="${escapeAttribute(id)}"></a>\n\n` : "";
      return `\n\n${anchor}${"#".repeat(Number(node.tagName[1]))} ${content}\n\n`;
    },
  });

  converter.addRule("exactCode", {
    filter: (node) => node.nodeName === "PRE",
    replacement(_content, node) {
      const code = node.querySelector("code");
      const language = code?.className.match(/(?:^|\s)language-([\w+.-]+)/u)?.[1] ?? "";
      const text = code?.textContent ?? node.textContent;
      const runs = text.match(/`+/gu) ?? [];
      const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
      const newline = text.endsWith("\n") ? "" : "\n";
      return `\n\n${fence}${language}\n${text}${newline}${fence}\n\n`;
    },
  });

  converter.addRule("safeTableCell", {
    filter: ["th", "td"],
    replacement(content, node) {
      const prefix = node.previousElementSibling ? " " : "| ";
      const value = content
        .trim()
        .replace(/\r?\n/gu, " ")
        .replace(/(?<!\\)\|/gu, "\\|");
      return `${prefix}${value} |`;
    },
  });
}

const converter = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
addExportRules(converter);

export function exportMarkdown(html, canonical, canonicalPaths) {
  const document = domino.createDocument(html);
  const main = document.querySelector("main");
  if (!main) throw new Error(`Missing content in ${canonical}.`);
  const article = Array.from(main.children).find((element) => element.tagName === "ARTICLE");
  const content = article ?? main;
  const pageUrl = new URL(canonical);
  const reference = main.querySelector('footer a[href*="reference/api-"]');
  const rawReport = reference ? normalizeUrl(reference.getAttribute("href"), pageUrl, canonicalPaths) : undefined;

  labelHomepageCode(content, document);
  for (const element of Array.from(content.querySelectorAll(CHROME))) element.remove();
  makeLinksAbsolute(content, pageUrl, canonicalPaths);
  preserveCaptions(content, document);

  const markdown = converter.turndown(content.innerHTML);
  const declarations = rawReport ? `\n\n[Full exported declarations (raw Markdown)](${rawReport})` : "";
  return `${markdown}${declarations}\n\nCanonical page: <${canonical}>\n`;
}
