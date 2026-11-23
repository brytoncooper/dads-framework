/* global document, localStorage, window */
(() => {
  try {
    let theme = localStorage.getItem("dads-theme");
    if (!theme && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
      theme = "light";
    }
    document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
  } catch {
    // Ignore storage access errors.
  }
})();
