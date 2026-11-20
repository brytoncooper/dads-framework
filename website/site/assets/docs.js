/* global Event, ResizeObserver, document, window, HTMLElement */
import { enableExampleCopy } from "./docs-copy.js";

const menu = document.querySelector(".docs-menu");
const smallScreen = window.matchMedia("(max-width: 52rem)");
function syncMenu() {
  menu.open = !smallScreen.matches;
}
smallScreen.addEventListener("change", syncMenu);
syncMenu();

const search = document.querySelector("#docs-search");
search.placeholder = "Try permissions or migrations";
document.addEventListener("keydown", (event) => {
  const typing =
    event.target instanceof HTMLElement &&
    (event.target.matches("input, textarea, select") ||
      event.target.isContentEditable);
  if (
    event.key === "/" &&
    !typing &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  ) {
    event.preventDefault();
    search.focus();
  }
  if (
    event.key === "Escape" &&
    document.activeElement === search &&
    search.value
  ) {
    search.value = "";
    search.dispatchEvent(new Event("input"));
  }
});

const scrollAreas = document.querySelectorAll("article pre, .reader-table");
const resize = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    if (target.scrollWidth > target.clientWidth)
      target.setAttribute("tabindex", "0");
    else target.removeAttribute("tabindex");
  }
});
for (const area of scrollAreas) resize.observe(area);

enableExampleCopy(document.querySelector("article"));
