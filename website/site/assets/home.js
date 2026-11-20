/* global Range, document, window, navigator, setTimeout, clearTimeout */
const copy = document.querySelector("#copy-command");
const command = document.querySelector("#install-command");
const copyStatus = document.querySelector("#copy-status");
let resetCopyFeedback;

copy.hidden = false;
copy.addEventListener("click", async () => {
  clearTimeout(resetCopyFeedback);
  try {
    await navigator.clipboard.writeText(command.textContent);
    copy.textContent = "Copied";
    copyStatus.textContent = "Install command copied.";
  } catch {
    const selection = window.getSelection();
    const range = new Range();
    range.selectNodeContents(command);
    selection.removeAllRanges();
    selection.addRange(range);
    copyStatus.textContent = "Install command selected for manual copying.";
    copy.textContent = "Selected";
  }
  resetCopyFeedback = setTimeout(() => {
    copy.textContent = "Copy";
    copyStatus.textContent = "";
  }, 2200);
});
