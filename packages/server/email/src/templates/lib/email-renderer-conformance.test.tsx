import React from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEmailTemplate, renderEmailTemplate } from "../index.js";

const title = "A&B <review>";
const destination = "https://example.test/confirm?item=123&mode=read";
const template = defineEmailTemplate({
  name: "conformance.review-notice",
  description: "Sends a review notice using a recipient-provided subject.",
  props: z.object({
    title: z.string().trim(),
    destination: z.url(),
  }),
  subject: (props) => props.title,
  preview: () => "Open the review details",
  body: (props) => (
    <p>
      {props.title}
      <a href={props.destination}>Review</a>
    </p>
  ),
  samples: { default: { title, destination } },
});

describe("React Email rendering contract", () => {
  it("uses parsed props in subject and both body formats", async () => {
    const rendered = await renderEmailTemplate(template, {
      title: `  ${title}  `,
      destination,
    });

    expect(rendered.subject).toBe(title);
    expect(rendered.preview).toBe("Open the review details");
    expect(rendered.html).toContain("A&amp;B &lt;review&gt;");
    expect(rendered.html).toContain('href="https://example.test/confirm?item=123&amp;mode=read"');
    expect(rendered.text).toContain(title);
    expect(rendered.text).toContain(destination);
    expect(rendered.text).not.toContain("Open the review details");
  });

  it("rejects malformed stored props before rendering a body", async () => {
    await expect(renderEmailTemplate(template, { title, destination: "invalid" })).rejects.toThrow(template.name);
  });
});
