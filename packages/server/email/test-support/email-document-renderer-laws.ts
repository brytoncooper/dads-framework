import { equal, match, doesNotMatch, rejects } from "node:assert/strict";
import { createElement } from "react";
import { z } from "zod";

import type { EmailDocumentRenderer } from "../src/templates/lib/email-document-renderer.js";
import { defineEmailTemplate } from "../src/templates/lib/email-template.js";
import { createEmailTemplateRenderer } from "../src/templates/lib/render-email-template.js";

const URL = "https://example.test/confirm?item=123&mode=read";
const NAME = "A&B <review>";
const TEMPLATE = defineEmailTemplate({
  name: "conformance.review-notice",
  description: "Displays the details of a review for the recipient.",
  props: z.object({ name: z.string().trim(), link: z.url() }),
  subject: ({ name }) => name,
  preview: () => "Preview details",
  body: ({ name, link }) => createElement("p", null, name, " ", createElement("a", { href: link }, "Details")),
  samples: { default: { name: NAME, link: URL } },
});

export function runEmailDocumentRendererLaws(
  open: () => EmailDocumentRenderer,
  register: (title: string, run: () => Promise<void>) => void,
): void {
  register("renders identical content and links in the paired bodies", async () => {
    const render = createEmailTemplateRenderer(open());
    const message = await render(TEMPLATE, {
      name: `  ${NAME}  `,
      link: URL,
    });
    equal(message.subject, NAME);
    equal(message.preview, "Preview details");
    match(message.html, /A&amp;B &lt;review&gt;/);
    match(message.html, /href="https:\/\/example\.test\/confirm\?item=123&amp;mode=read"/);
    match(message.text, /A&B <review>/);
    match(message.text, /https:\/\/example\.test\/confirm\?item=123&mode=read/);
    doesNotMatch(message.text, /Preview details/);
  });

  register("refuses invalid stored props before returning either body", async () => {
    const render = createEmailTemplateRenderer(open());
    await rejects(() => render(TEMPLATE, { name: NAME, link: "bad input" }), /conformance\.review-notice/);
  });
}
