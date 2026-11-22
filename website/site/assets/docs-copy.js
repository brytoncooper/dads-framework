/* global navigator, setTimeout, clearTimeout */
export function enableExampleCopy(article) {
  if (!article || !navigator.clipboard?.writeText) return;

  for (const example of article.querySelectorAll(".docs-example")) {
    const code = example.querySelector("pre > code");
    const button = example.querySelector("button");
    const feedback = example.querySelector('[role="status"]');

    let reset;
    button.hidden = false;
    button.addEventListener("click", async () => {
      clearTimeout(reset);
      feedback.textContent = "";
      try {
        await navigator.clipboard.writeText(code.textContent);
        button.textContent = "Copied";
        button.dataset.copied = "true";
        feedback.textContent = "Code copied.";
      } catch {
        button.textContent = "Copy failed";
        feedback.textContent =
          "Copy failed. Select and copy the code manually.";
      }
      reset = setTimeout(() => {
        button.textContent = "Copy";
        delete button.dataset.copied;
        feedback.textContent = "";
      }, 2400);
    });
  }
}
