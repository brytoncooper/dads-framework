import assert from "node:assert/strict";
import test from "node:test";
import domino from "@mixmark-io/domino";
import { renderDocs, siteHeader } from "./build.mjs";
import { addDocsReader } from "./docs-reader.mjs";
import { exportMarkdown } from "./markdown-export.mjs";
import { enableSearchModal } from "../site/assets/docs.js";

const sampleDocHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Quickstart · Dads documentation</title>
<link rel="stylesheet" href="assets/site.css">
</head>
<body>
<header><a href="index.html">Dads documentation</a><a href="llms.txt">llms.txt</a></header>
<div class="layout">
<nav aria-label="Documentation"><h2>Get started</h2><ul><li><a href="index.html">Why Dads</a></li><li><a href="quickstart.html" aria-current="page">Quickstart</a></li></ul></nav>
<main id="content" tabindex="-1">
<section class="search" role="search">
<label for="docs-search">Search documentation</label>
<input id="docs-search" type="search" autocomplete="off" placeholder="Try permissions or migration">
<p id="search-status" aria-live="polite"></p>
<ul id="search-results"></ul>
</section>

<article><h1 id="quickstart">Quickstart</h1>
<p>Start a new Dads backend with PostgreSQL.</p>
<h2 id="install">Install</h2>
<p>Run the starter generator.</p>
<h2 id="verify">Verify</h2>
<p>Run the check suite.</p>
</article>
<footer><span>Owner <code>create-dads</code></span><a href="source/docs/site/guides/quickstart.md">Markdown source</a></footer>
</main>
</div>
</body>
</html>`;

function defineMethod(target, name, value) {
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function createInteractiveDom(userAgent = "Mozilla/5.0 (Macintosh)") {
  const rendered = renderDocs(sampleDocHtml, "quickstart.html");
  const document = domino.createDocument(rendered);
  const dialog = document.querySelector("#docs-search-dialog");
  const search = document.querySelector("#docs-search");

  let open = false;
  let showModalCalls = 0;
  let closeCalls = 0;
  let activeElement = document.body;

  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => activeElement,
  });

  defineMethod(search, "focus", () => {
    activeElement = search;
  });
  defineMethod(search, "select", () => {});

  Object.defineProperty(dialog, "open", {
    configurable: true,
    get: () => open,
  });
  defineMethod(dialog, "showModal", () => {
    showModalCalls += 1;
    open = true;
    dialog.setAttribute("open", "");
  });
  defineMethod(dialog, "close", () => {
    closeCalls += 1;
    open = false;
    dialog.removeAttribute("open");
  });
  defineMethod(dialog, "getBoundingClientRect", () => ({
    left: 200,
    right: 800,
    top: 100,
    bottom: 500,
  }));

  const listeners = new Map();
  const addListener = (target, type, handler) => {
    if (!listeners.has(target)) listeners.set(target, new Map());
    const map = listeners.get(target);
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(handler);
  };
  const dispatch = (target, type, eventInit = {}) => {
    let prevented = false;
    const event = {
      type,
      target,
      key: "",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      clientX: 0,
      clientY: 0,
      preventDefault() {
        prevented = true;
      },
      ...eventInit,
    };
    const handlers = listeners.get(target)?.get(type) ?? [];
    for (const handler of handlers) handler(event);
    return { event, prevented };
  };

  for (const node of [
    document,
    dialog,
    search,
    document.querySelector("#docs-search-trigger"),
    document.querySelector("#search-results"),
    dialog.querySelector(".search-close"),
  ]) {
    defineMethod(node, "addEventListener", (type, handler) =>
      addListener(node, type, handler),
    );
  }

  const win = { navigator: { userAgent } };
  enableSearchModal(document, win);

  return {
    document,
    dialog,
    search,
    dispatch,
    getShowModalCalls: () => showModalCalls,
    getCloseCalls: () => closeCalls,
  };
}

test("siteHeader renders search trigger only on docs pages", () => {
  const docsDoc = domino.createDocument(siteHeader("docs"));
  const trigger = docsDoc.querySelector("#docs-search-trigger");
  assert.ok(trigger);
  assert.equal(trigger.tagName, "BUTTON");
  assert.equal(trigger.getAttribute("type"), "button");
  assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  assert.equal(trigger.getAttribute("aria-controls"), "docs-search-dialog");
  assert.ok(trigger.querySelector("svg"));
  assert.match(trigger.textContent, /Search/u);
  assert.equal(trigger.querySelector("kbd")?.textContent, "⌘K");

  const navLinks = Array.from(docsDoc.querySelectorAll("nav a")).map((a) =>
    a.textContent.trim(),
  );
  assert.deepEqual(navLinks, ["Docs", "GitHub ↗"]);

  const homeDoc = domino.createDocument(siteHeader("home"));
  assert.equal(Boolean(homeDoc.querySelector("#docs-search-trigger")), false);
  const otherDoc = domino.createDocument(siteHeader(""));
  assert.equal(Boolean(otherDoc.querySelector("#docs-search-trigger")), false);
});

test("docs-reader wraps search in native dialog outside main and preserves search.js hooks", () => {
  const rendered = renderDocs(sampleDocHtml, "quickstart.html");
  const document = domino.createDocument(rendered);

  const main = document.querySelector("main");
  assert.equal(main.firstElementChild.tagName, "ARTICLE");
  assert.equal(Boolean(main.querySelector("dialog")), false);
  assert.equal(Boolean(main.querySelector(".search")), false);

  const dialog = document.querySelector("dialog#docs-search-dialog");
  assert.ok(dialog);
  assert.equal(dialog.parentNode.tagName, "BODY");
  assert.ok(dialog.classList.contains("search-dialog"));
  assert.equal(dialog.getAttribute("closedby"), "any");
  assert.equal(dialog.getAttribute("aria-label"), "Search documentation");
  assert.equal(dialog.getAttribute("role"), null);
  assert.equal(dialog.getAttribute("aria-modal"), null);

  const section = dialog.querySelector('section.search[role="search"]');
  assert.ok(section);
  assert.ok(section.querySelector("#docs-search"));
  assert.ok(section.querySelector("#docs-search").hasAttribute("autofocus"));
  assert.ok(section.querySelector("#search-status"));
  assert.ok(section.querySelector("#search-results"));
  assert.ok(section.querySelector("button.search-close"));
  assert.ok(section.querySelector(".search-hint"));

  assert.match(
    rendered,
    /<noscript><style>\.header-search-trigger\{display:none\}<\/style><\/noscript>/u,
  );
});

test("markdown export omits header search trigger and search dialog completely", () => {
  const rendered = renderDocs(sampleDocHtml, "quickstart.html");
  const canonicals = new Map([["/docs/quickstart.html", "/docs/quickstart"]]);
  const markdown = exportMarkdown(
    rendered,
    "https://dadsframework.dev/docs/quickstart",
    canonicals,
  );

  assert.match(markdown, /# Quickstart/u);
  assert.match(markdown, /Start a new Dads backend with PostgreSQL\./u);
  assert.doesNotMatch(
    markdown,
    /Search documentation|Type to search|⌘K|navigate|Close search/u,
  );
});

test("fragment HTML without body still places dialog outside article", () => {
  const fragment = `<main><section class="search" role="search"><label for="docs-search">Search</label><input id="docs-search" type="search"><p id="search-status"></p><ul id="search-results"></ul></section><article><h1>Title</h1></article></main>`;
  const transformed = addDocsReader(fragment, "index.html");
  const document = domino.createDocument(transformed);
  const article = document.querySelector("article");
  assert.equal(Boolean(article.querySelector("dialog")), false);
  assert.equal(Boolean(article.querySelector(".search")), false);
  assert.ok(document.querySelector("dialog#docs-search-dialog #docs-search"));
});

test("search modal opens on trigger click, Cmd+K, Ctrl+K, and slash outside inputs", () => {
  const {
    document,
    dialog,
    search,
    dispatch,
    getShowModalCalls,
    getCloseCalls,
  } = createInteractiveDom("Mozilla/5.0 (X11; Linux x86_64)");

  assert.equal(
    document.querySelector(".header-search-shortcut")?.textContent,
    "Ctrl K",
  );

  const trigger = document.querySelector("#docs-search-trigger");
  dispatch(trigger, "click");
  assert.equal(dialog.open, true);
  assert.equal(getShowModalCalls(), 1);
  assert.equal(document.activeElement, search);

  dispatch(dialog.querySelector(".search-close"), "click");
  assert.equal(dialog.open, false);
  assert.equal(getCloseCalls(), 1);

  const cmdK = dispatch(document, "keydown", { key: "k", metaKey: true });
  assert.equal(cmdK.prevented, true);
  assert.equal(dialog.open, true);

  dispatch(document, "keydown", { key: "k", metaKey: true });
  assert.equal(dialog.open, false);

  const ctrlK = dispatch(document, "keydown", { key: "K", ctrlKey: true });
  assert.equal(ctrlK.prevented, true);
  assert.equal(dialog.open, true);
  dialog.close();

  const textInput = document.createElement("input");
  const slashInInput = dispatch(document, "keydown", {
    key: "/",
    target: textInput,
  });
  assert.equal(slashInInput.prevented, false);
  assert.equal(dialog.open, false);

  const slashOutside = dispatch(document, "keydown", {
    key: "/",
    target: document.body,
  });
  assert.equal(slashOutside.prevented, true);
  assert.equal(dialog.open, true);
});

test("search modal supports ArrowDown, ArrowUp, Enter navigation and backdrop light-dismiss fallback", () => {
  const { document, dialog, search, dispatch } = createInteractiveDom();
  const results = document.querySelector("#search-results");
  const clicked = [];

  results.innerHTML =
    '<li><a href="http.html">HTTP and contracts</a></li><li><a href="permissions.html">Permissions</a></li>';
  const links = Array.from(results.querySelectorAll("a"));
  for (const link of links) {
    defineMethod(link, "click", () => {
      clicked.push(link.getAttribute("href"));
    });
  }

  dispatch(document, "keydown", { key: "k", metaKey: true });
  assert.equal(links[0].getAttribute("data-active"), "true");
  assert.equal(links[1].getAttribute("data-active"), null);

  const down = dispatch(document, "keydown", { key: "ArrowDown" });
  assert.equal(down.prevented, true);
  assert.equal(links[0].getAttribute("data-active"), null);
  assert.equal(links[1].getAttribute("data-active"), "true");

  const enter = dispatch(document, "keydown", { key: "Enter" });
  assert.equal(enter.prevented, true);
  assert.deepEqual(clicked, ["permissions.html"]);

  dispatch(document, "keydown", { key: "ArrowUp" });
  assert.equal(links[0].getAttribute("data-active"), "true");

  // Pointer press inside dialog and release outside should not dismiss.
  dispatch(dialog, "pointerdown", { clientX: 400, clientY: 250 });
  dispatch(dialog, "pointerup", { clientX: 50, clientY: 50 });
  assert.equal(dialog.open, true);

  // Pointer press and release outside dialog dismisses cleanly.
  dispatch(dialog, "pointerdown", { clientX: 50, clientY: 50 });
  dispatch(dialog, "pointerup", { clientX: 50, clientY: 50 });
  assert.equal(dialog.open, false);

  // Ensure search input was focused on open.
  assert.equal(document.activeElement, search);
});
