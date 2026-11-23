import { render } from "@react-email/render";
import type { ReactElement } from "react";

/** Turns the framed template into an HTML body and its plain-text equivalent. */
export type EmailDocumentRenderer = {
  render(document: ReactElement): Promise<{
    readonly html: string;
    readonly text: string;
  }>;
};

class ReactEmailDocumentRenderer implements EmailDocumentRenderer {
  async render(document: ReactElement) {
    const [html, text] = await Promise.all([
      render(document),
      // Keep long links intact in plain-text mail clients.
      render(document, {
        plainText: true,
        htmlToTextOptions: { wordwrap: false },
      }),
    ]);
    return { html, text };
  }
}

export function createReactEmailDocumentRenderer(): EmailDocumentRenderer {
  return new ReactEmailDocumentRenderer();
}
