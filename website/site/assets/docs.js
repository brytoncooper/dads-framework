/* global IntersectionObserver, ResizeObserver, document, requestAnimationFrame, window */
import { enableExampleCopy } from "./docs-copy.js";

function isTypingTarget(target) {
  if (!target || typeof target.matches !== "function") return false;
  return target.matches("input, textarea, select") || Boolean(target.isContentEditable);
}

function isOutsideDialog(event, dialog) {
  const rect = dialog.getBoundingClientRect();
  return (
    event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
  );
}

export function enableSearchModal(doc = document, win = window) {
  const search = doc.querySelector("#docs-search");
  if (!search) return;

  const dialog = doc.querySelector("#docs-search-dialog");
  const trigger = doc.querySelector("#docs-search-trigger");
  const results = doc.querySelector("#search-results");
  const closeButton = dialog?.querySelector(".search-close");
  const shortcutBadge = trigger?.querySelector(".header-search-shortcut");

  search.placeholder = "Search permissions, routes, migrations";

  if (shortcutBadge && !/Mac|iPhone|iPad|iPod/iu.test(win?.navigator?.userAgent ?? "")) {
    shortcutBadge.textContent = "Ctrl K";
  }

  let activeIndex = -1;

  const isOpen = () => Boolean(dialog && (dialog.open || dialog.hasAttribute("open")));

  const resultLinks = () => (results ? Array.from(results.querySelectorAll("a")) : []);

  const setActive = (index) => {
    const links = resultLinks();
    activeIndex = index >= 0 && index < links.length ? index : -1;
    for (let i = 0; i < links.length; i += 1) {
      if (i === activeIndex) links[i].setAttribute("data-active", "true");
      else links[i].removeAttribute("data-active");
    }
  };

  const syncResults = () => {
    const links = resultLinks();
    setActive(links.length > 0 ? 0 : -1);
  };

  const openSearch = () => {
    if (dialog && !isOpen()) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    search.focus();
    search.select?.();
    syncResults();
  };

  const closeSearch = () => {
    if (!dialog || !isOpen()) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };

  trigger?.addEventListener("click", openSearch);
  closeButton?.addEventListener("click", closeSearch);
  search.addEventListener("input", syncResults);

  if (results) {
    results.addEventListener("mouseover", (event) => {
      const link = event.target?.closest?.("a");
      if (!link) return;
      const index = resultLinks().indexOf(link);
      if (index !== -1) setActive(index);
    });
    results.addEventListener("click", (event) => {
      if (event.target?.closest?.("a")) closeSearch();
    });
    if (typeof win?.MutationObserver === "function") {
      const observer = new win.MutationObserver(syncResults);
      observer.observe(results, { childList: true });
    }
  }

  const hasNativeClosedBy =
    typeof win?.HTMLDialogElement === "function" && "closedBy" in win.HTMLDialogElement.prototype;
  if (dialog && !hasNativeClosedBy) {
    let pressedOutside = false;
    dialog.addEventListener("pointerdown", (event) => {
      pressedOutside = isOpen() && isOutsideDialog(event, dialog);
    });
    dialog.addEventListener("pointerup", (event) => {
      if (pressedOutside && isOpen() && isOutsideDialog(event, dialog)) {
        closeSearch();
      }
      pressedOutside = false;
    });
  }

  doc.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && !event.altKey && key === "k") {
      event.preventDefault();
      if (isOpen()) closeSearch();
      else openSearch();
      return;
    }

    if (
      event.key === "/" &&
      !isTypingTarget(event.target) &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !isOpen()
    ) {
      event.preventDefault();
      openSearch();
      return;
    }

    if (!dialog || !isOpen()) return;

    if (event.key === "Escape" && typeof dialog.showModal !== "function") {
      event.preventDefault();
      closeSearch();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const links = resultLinks();
      if (links.length === 0) return;
      event.preventDefault();
      const next =
        event.key === "ArrowDown"
          ? activeIndex < links.length - 1
            ? activeIndex + 1
            : 0
          : activeIndex > 0
            ? activeIndex - 1
            : links.length - 1;
      setActive(next);
      links[next].scrollIntoView?.({ block: "nearest" });
      return;
    }

    if (event.key === "Enter" && doc.activeElement === search) {
      const links = resultLinks();
      const target = links[activeIndex] ?? links[0];
      if (target) {
        event.preventDefault();
        target.click();
      }
    }
  });
}

function enableFileGroups(article) {
  if (!article) return;
  for (const group of article.querySelectorAll("[data-file-group]")) {
    const tabs = Array.from(group.querySelectorAll('[role="tab"]'));
    const panels = Array.from(group.querySelectorAll('[role="tabpanel"]'));
    if (tabs.length < 2) continue;

    const activate = (nextTab, moveFocus = false) => {
      const targetId = nextTab.getAttribute("aria-controls");
      for (const tab of tabs) {
        const selected = tab === nextTab;
        tab.setAttribute("aria-selected", selected ? "true" : "false");
        if (selected) tab.removeAttribute("tabindex");
        else tab.setAttribute("tabindex", "-1");
      }
      for (const panel of panels) {
        panel.setAttribute("data-active", panel.id === targetId ? "true" : "false");
      }
      if (moveFocus) nextTab.focus();
    };

    for (const tab of tabs) {
      tab.addEventListener("click", () => activate(tab));
      tab.addEventListener("keydown", (event) => {
        const current = tabs.indexOf(tab);
        let nextIndex = -1;
        if (event.key === "ArrowDown" || event.key === "ArrowRight") {
          nextIndex = (current + 1) % tabs.length;
        } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
          nextIndex = (current - 1 + tabs.length) % tabs.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = tabs.length - 1;
        }
        if (nextIndex !== -1) {
          event.preventDefault();
          activate(tabs[nextIndex], true);
        }
      });
    }
  }
}

function enableTocScrollspy() {
  const toc = document.querySelector(".reader-toc");
  if (!toc) return;

  const items = Array.from(toc.querySelectorAll('a[href^="#"]'))
    .map((link) => {
      const id = link.getAttribute("href")?.slice(1);
      const heading = id ? document.getElementById(id) : null;
      return id && heading ? { id, link, heading } : null;
    })
    .filter(Boolean);

  if (items.length === 0) return;

  let activeId = "";
  const setActive = (id) => {
    if (!id || id === activeId) return;
    activeId = id;
    for (const item of items) {
      if (item.id === id) item.link.setAttribute("aria-current", "location");
      else item.link.removeAttribute("aria-current");
    }
  };

  const resolveActive = () => {
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 24;
    if (nearBottom) {
      setActive(items[items.length - 1].id);
      return;
    }
    let current = items[0].id;
    for (const item of items) {
      if (item.heading.getBoundingClientRect().top <= 128) current = item.id;
      else break;
    }
    setActive(current);
  };

  let framePending = false;
  const scheduleSync = () => {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      resolveActive();
    });
  };

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(scheduleSync, {
      rootMargin: "-96px 0px -65% 0px",
      threshold: [0, 1],
    });
    for (const item of items) observer.observe(item.heading);
  }

  window.addEventListener("scroll", scheduleSync, { passive: true });
  window.addEventListener("hashchange", () => {
    const hashId = window.location.hash.slice(1);
    if (items.some((item) => item.id === hashId)) setActive(hashId);
    else scheduleSync();
  });

  const initialHash = window.location.hash.slice(1);
  if (items.some((item) => item.id === initialHash)) setActive(initialHash);
  else resolveActive();
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  const menu = document.querySelector(".docs-menu");
  if (menu) {
    const smallScreen = window.matchMedia("(max-width: 52rem)");
    const syncMenu = () => {
      menu.open = !smallScreen.matches;
    };
    smallScreen.addEventListener("change", syncMenu);
    syncMenu();
  }

  enableSearchModal(document, window);

  const scrollAreas = document.querySelectorAll("article pre, .reader-table");
  if (scrollAreas.length > 0 && "ResizeObserver" in window) {
    const resize = new ResizeObserver((entries) => {
      for (const { target } of entries) {
        if (target.scrollWidth > target.clientWidth) target.setAttribute("tabindex", "0");
        else target.removeAttribute("tabindex");
      }
    });
    for (const area of scrollAreas) resize.observe(area);
  }

  const article = document.querySelector("article");
  enableExampleCopy(article);
  enableFileGroups(article);
  enableTocScrollspy();
}
