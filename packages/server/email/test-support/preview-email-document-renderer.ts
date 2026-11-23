import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { EmailDocumentRenderer } from "../src/templates/lib/email-document-renderer.js";

class PreviewEmailDocumentRenderer implements EmailDocumentRenderer {
  render(document: ReactElement) {
    const html = `<!doctype html>${renderToStaticMarkup(document)}`;
    const preview = new DOMParser().parseFromString(html, "text/html");
    for (const hidden of preview.querySelectorAll(
      "style, script, [data-skip-in-text]",
    )) {
      hidden.remove();
    }
    for (const link of preview.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href");
      if (href !== null && link.textContent !== href) link.append(` [${href}]`);
    }
    const text = preview.body.textContent.replace(/\s+/g, " ").trim();
    return Promise.resolve({ html, text });
  }
}

export function openPreviewEmailDocumentRenderer(): EmailDocumentRenderer {
  return new PreviewEmailDocumentRenderer();
}
