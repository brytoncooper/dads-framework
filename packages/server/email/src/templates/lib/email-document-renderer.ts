import type * as ReactEmailRender from "@react-email/render";
import type { ReactElement } from "react";

import { loadOptionalPeer } from "../../optional-peer.js";

/** Turns the framed template into an HTML body and its plain-text equivalent. */
export type EmailDocumentRenderer = {
  render(document: ReactElement): Promise<{
    readonly html: string;
    readonly text: string;
  }>;
};

export function loadReactEmailRender(
  load: () => Promise<typeof ReactEmailRender> = () => import("@react-email/render"),
): Promise<typeof ReactEmailRender> {
  return loadOptionalPeer("@dads-framework/email/templates", "@react-email/render", load);
}

class ReactEmailDocumentRenderer implements EmailDocumentRenderer {
  async render(document: ReactElement) {
    const { render } = await loadReactEmailRender();
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
