/* global Range, document, window, navigator, setTimeout, clearTimeout */

// 1. Hero install command copy + Minimal / Example template toggle
const copy = document.querySelector("#copy-command");
const command = document.querySelector("#install-command");
const copyStatus = document.querySelector("#copy-status");
const templateSwitch = document.querySelector(".template-switch");
const templateTree = document.querySelector("#template-tree");
const templateCaption = document.querySelector("#template-caption");

const FOLDER_SVG =
  '<svg class="ft-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 3.5A1.25 1.25 0 0 1 3 2.25h3.1c.33 0 .65.13.88.37l.9.9H13A1.25 1.25 0 0 1 14.25 4.77v6.98A1.25 1.25 0 0 1 13 13H3a1.25 1.25 0 0 1-1.25-1.25V3.5Z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>';
const FILE_SVG =
  '<svg class="ft-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.25h5.75L12.5 5.5v8.25a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V3.25a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.25 2.25V5.5h3.25" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>';

function renderTreeRows(rows) {
  return rows
    .map(
      ({ depth, kind, name, note }) =>
        `<li class="ft-row" data-depth="${depth}" data-kind="${kind}">` +
        `<span class="ft-node">${kind === "dir" ? FOLDER_SVG : FILE_SVG}<code class="ft-name">${name}</code></span>` +
        (note ? `<span class="ft-note">${note}</span>` : "") +
        `</li>`,
    )
    .join("");
}

const TEMPLATES = {
  minimal: {
    command: "npm create dads@latest my-app -- --template minimal",
    rows: [
      { depth: 0, kind: "dir", name: "my-app/" },
      {
        depth: 1,
        kind: "dir",
        name: "apps/",
        note: "Entrypoints that expose routes",
      },
      {
        depth: 2,
        kind: "ts",
        name: "customer/app.ts",
        note: "Public API for your users",
      },
      {
        depth: 2,
        kind: "ts",
        name: "staff/app.ts",
        note: "Internal API for your team",
      },
      {
        depth: 1,
        kind: "dir",
        name: "domains/",
        note: "Your isolated features",
      },
      {
        depth: 2,
        kind: "dir",
        name: "tenants/",
        note: "Built-in auth, users & workspaces",
      },
      {
        depth: 1,
        kind: "dir",
        name: "assembly/",
        note: "Server startup, Postgres & env",
      },
      {
        depth: 1,
        kind: "json",
        name: "dads.project.json",
        note: "Import rules enforced in CI",
      },
    ],
    caption:
      "Full backend shape, zero demo code. Add your first resource with <code>npx dad add resource</code>.",
  },
  example: {
    command: "npm create dads@latest my-app",
    rows: [
      { depth: 0, kind: "dir", name: "my-app/" },
      {
        depth: 1,
        kind: "dir",
        name: "apps/",
        note: "Entrypoints that expose routes",
      },
      {
        depth: 2,
        kind: "ts",
        name: "customer/app.ts",
        note: "User API + notes endpoints",
      },
      {
        depth: 2,
        kind: "ts",
        name: "staff/app.ts",
        note: "Admin API + audit exports",
      },
      {
        depth: 2,
        kind: "dir",
        name: "web/",
        note: "React 19 UI + permissions demo",
      },
      {
        depth: 1,
        kind: "dir",
        name: "domains/",
        note: "Your isolated features",
      },
      {
        depth: 2,
        kind: "dir",
        name: "notes/",
        note: "Example feature: CRUD + files",
      },
      {
        depth: 2,
        kind: "dir",
        name: "tenants/",
        note: "Auth, SSO, SCIM & workspaces",
      },
      {
        depth: 1,
        kind: "dir",
        name: "assembly/",
        note: "Server startup, Postgres & env",
      },
    ],
    caption:
      "Complete runnable app with notes, permissions dashboard, attachments, exports, and multi-user examples.",
  },
};

if (templateSwitch && command && templateTree && templateCaption) {
  const tabs = [...templateSwitch.querySelectorAll('[role="tab"]')];
  templateSwitch.hidden = false;

  const selectTemplate = (selected) => {
    const key = selected.dataset.template;
    const config = TEMPLATES[key];
    if (!config) return;
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    command.textContent = config.command;
    templateTree.innerHTML = renderTreeRows(config.rows);
    templateCaption.innerHTML = config.caption;
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTemplate(tab));
  }
}

async function copyText(text, button, statusEl, defaultLabel) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    if (statusEl) statusEl.textContent = "Copied to clipboard.";
  } catch {
    button.textContent = "Copy failed";
  }
  return setTimeout(() => {
    button.textContent = defaultLabel;
    if (statusEl) statusEl.textContent = "";
  }, 2000);
}

if (copy && command) {
  let resetCopyFeedback;
  copy.hidden = false;
  copy.addEventListener("click", async () => {
    clearTimeout(resetCopyFeedback);
    try {
      await navigator.clipboard.writeText(command.textContent);
      copy.textContent = "Copied";
      if (copyStatus) copyStatus.textContent = "Install command copied.";
    } catch {
      const selection = window.getSelection();
      const range = new Range();
      range.selectNodeContents(command);
      selection.removeAllRanges();
      selection.addRange(range);
      if (copyStatus)
        copyStatus.textContent = "Install command selected for manual copying.";
      copy.textContent = "Selected";
    }
    resetCopyFeedback = setTimeout(() => {
      copy.textContent = "Copy";
      if (copyStatus) copyStatus.textContent = "";
    }, 2200);
  });
}

// 2. End-to-end tabbed code box
const codeBox = document.querySelector("[data-code-tabs]");
if (codeBox) {
  const tabList = codeBox.querySelector('[role="tablist"]');
  const tabs = [...tabList.querySelectorAll('[role="tab"]')];
  const fileLabel = codeBox.querySelector("#code-box-file");
  const copyBtn = codeBox.querySelector("#code-box-copy");
  let activePanel = document.getElementById(
    tabs[0].getAttribute("aria-controls"),
  );
  let resetCodeCopy;

  const activateTab = (selected) => {
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute("aria-controls"));
      if (panel) {
        panel.hidden = !active;
        if (active) {
          activePanel = panel;
          if (fileLabel && panel.dataset.file) {
            fileLabel.textContent = panel.dataset.file;
          }
        }
      }
    }
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => activateTab(tab));
  }

  tabList.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    let next;
    if (event.key === "ArrowLeft")
      next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
    else if (event.key === "Home") next = tabs[0];
    else if (event.key === "End") next = tabs.at(-1);
    else return;
    event.preventDefault();
    activateTab(next);
    next.focus();
  });

  if (copyBtn) {
    copyBtn.hidden = false;
    copyBtn.addEventListener("click", async () => {
      clearTimeout(resetCodeCopy);
      const code = activePanel?.querySelector("code")?.textContent ?? "";
      resetCodeCopy = await copyText(code, copyBtn, null, "Copy");
    });
  }
}
