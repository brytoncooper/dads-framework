/* global document, localStorage */
(() => {
  const storageKey = "dads-theme";
  const root = document.documentElement;

  const getCurrentTheme = () => (root.dataset.theme === "light" ? "light" : "dark");

  const applyTheme = (theme) => {
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", theme === "light" ? "#f8fafc" : "#0e1114");
    }
    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      const next = theme === "light" ? "dark" : "light";
      button.setAttribute("aria-label", `Switch to ${next} mode`);
      button.setAttribute("title", `Switch to ${next} mode`);
      button.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    }
  };

  applyTheme(getCurrentTheme());

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-theme-toggle]");
    if (!button) return;
    const next = getCurrentTheme() === "light" ? "dark" : "light";
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Ignore storage failures in private browsing.
    }
    applyTheme(next);
  });
})();
