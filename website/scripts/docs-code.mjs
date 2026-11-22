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

const FILE_PATH_PATTERN =
  /^[a-zA-Z0-9._@-]+(?:\/[a-zA-Z0-9._@-]+)*\.[a-zA-Z0-9]+$/u;

const FOLDER_ICON = `<svg class="df-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 3.5A1.25 1.25 0 0 1 3 2.25h3.1c.33 0 .65.13.88.37l.9.9H13A1.25 1.25 0 0 1 14.25 4.77v6.98A1.25 1.25 0 0 1 13 13H3a1.25 1.25 0 0 1-1.25-1.25V3.5Z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>`;

const FILE_ICON = `<svg class="df-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.25h5.75L12.5 5.5v8.25a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V3.25a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.25 2.25V5.5h3.25" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>`;

function extractFileMeta(block) {
  const prev = block.previousElementSibling;
  if (!prev || prev.tagName !== "P") return undefined;
  const firstElement = prev.firstElementChild;
  if (!firstElement || firstElement.tagName !== "CODE") return undefined;
  if (prev.children.length !== 1) return undefined;
  const candidate = firstElement.textContent.trim();
  if (!FILE_PATH_PATTERN.test(candidate)) return undefined;
  const fullText = prev.textContent.trim();
  if (fullText === candidate) {
    return { element: prev, filePath: candidate, note: "" };
  }
  const rest = fullText.slice(candidate.length).trim();
  if (rest.startsWith("—") || rest.startsWith("-")) {
    const note = rest.replace(/^[—-]\s*/u, "").trim();
    return { element: prev, filePath: candidate, note };
  }
  return undefined;
}

function insertIntoTree(root, segments, entry) {
  let node = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const dirName = segments[index];
    let child = node.dirs.get(dirName);
    if (!child) {
      child = { name: dirName, dirs: new Map(), files: [] };
      node.dirs.set(dirName, child);
    }
    node = child;
  }
  node.files.push({
    name: segments[segments.length - 1],
    ...entry,
  });
}

function renderTreeNodes(document, node, depth, container) {
  for (const dir of node.dirs.values()) {
    const row = document.createElement("div");
    row.className = "docs-file-dir";
    row.style.setProperty("--depth", String(depth));
    row.innerHTML = `${FOLDER_ICON}<span></span>`;
    row.querySelector("span").textContent = `${dir.name}/`;
    container.appendChild(row);
    renderTreeNodes(document, dir, depth + 1, container);
  }
  for (const file of node.files) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "docs-file-tab";
    button.setAttribute("role", "tab");
    button.setAttribute("id", file.tabId);
    button.setAttribute("aria-controls", file.panelId);
    button.setAttribute("aria-selected", file.active ? "true" : "false");
    if (!file.active) button.setAttribute("tabindex", "-1");
    button.style.setProperty("--depth", String(depth));
    button.innerHTML = `${FILE_ICON}<span class="docs-file-tab-name"></span>`;
    button.querySelector(".docs-file-tab-name").textContent = file.name;
    container.appendChild(button);
  }
}

function groupConsecutiveFiles(document) {
  const article = document.querySelector("article");
  if (!article) return;

  const children = Array.from(article.children);
  let groupIndex = 0;
  let index = 0;
  while (index < children.length) {
    const start = children[index];
    if (
      !start.classList.contains("docs-example") ||
      !start.hasAttribute("data-file-path")
    ) {
      index += 1;
      continue;
    }
    const run = [start];
    let cursor = index + 1;
    while (
      cursor < children.length &&
      children[cursor].classList.contains("docs-example") &&
      children[cursor].hasAttribute("data-file-path")
    ) {
      run.push(children[cursor]);
      cursor += 1;
    }
    index = cursor;
    if (run.length < 2) continue;

    groupIndex += 1;
    const groupId = `docs-file-group-${String(groupIndex)}`;
    const group = document.createElement("div");
    group.className = "docs-file-group";
    group.setAttribute("data-file-group", "");

    const treeNav = document.createElement("nav");
    treeNav.className = "docs-file-tree";
    treeNav.setAttribute("aria-label", "Example files");

    const treeHead = document.createElement("div");
    treeHead.className = "docs-file-tree-head";
    treeHead.textContent = "Files";
    treeNav.appendChild(treeHead);

    const tabList = document.createElement("div");
    tabList.className = "docs-file-tree-list";
    tabList.setAttribute("role", "tablist");
    tabList.setAttribute("aria-orientation", "vertical");
    treeNav.appendChild(tabList);

    const panels = document.createElement("div");
    panels.className = "docs-file-panels";

    const rootTree = { name: "", dirs: new Map(), files: [] };
    run.forEach((example, itemIndex) => {
      const filePath = example.getAttribute("data-file-path") ?? "";
      const tabId = `${groupId}-tab-${String(itemIndex)}`;
      const panelId = `${groupId}-panel-${String(itemIndex)}`;
      const active = itemIndex === 0;
      insertIntoTree(rootTree, filePath.split("/"), {
        tabId,
        panelId,
        active,
      });
      example.setAttribute("role", "tabpanel");
      example.setAttribute("id", panelId);
      example.setAttribute("aria-labelledby", tabId);
      example.setAttribute("data-active", active ? "true" : "false");
    });

    renderTreeNodes(document, rootTree, 0, tabList);
    group.appendChild(treeNav);
    group.appendChild(panels);

    start.parentNode.insertBefore(group, start);
    for (const example of run) {
      panels.appendChild(example);
    }
  }
}

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
    const fileMeta = extractFileMeta(block);
    const displayLabel = fileMeta ? fileMeta.filePath : label;

    const wrapper = document.createElement("div");
    wrapper.className = "docs-example";
    if (fileMeta) {
      wrapper.setAttribute("data-file-path", fileMeta.filePath);
      if (fileMeta.note) wrapper.setAttribute("data-file-note", fileMeta.note);
    }
    wrapper.innerHTML = `<div class="docs-example-controls">
  <div class="docs-example-meta">
    <span class="docs-example-language"></span>
  </div>
  <button type="button" hidden>Copy</button>
  <span class="sr" role="status"></span>
</div>`;
    wrapper.querySelector(".docs-example-language").textContent = displayLabel;
    if (fileMeta?.note) {
      const noteEl = document.createElement("span");
      noteEl.className = "docs-example-note";
      noteEl.textContent = fileMeta.note;
      wrapper.querySelector(".docs-example-meta").appendChild(noteEl);
    }
    wrapper
      .querySelector("button")
      .setAttribute("aria-label", `Copy ${displayLabel} code`);
    block.setAttribute("role", "region");
    block.setAttribute("aria-label", `${displayLabel} code`);
    block.setAttribute("tabindex", "0");
    block.parentNode.replaceChild(wrapper, block);
    wrapper.appendChild(block);
    if (fileMeta) fileMeta.element.remove();
  }

  groupConsecutiveFiles(document);
  return document.outerHTML;
}
