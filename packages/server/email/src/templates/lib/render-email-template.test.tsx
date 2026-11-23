/**
 * The render contract: a template plus props becomes one message with four
 * parts, both bodies come from the same element, and the parts that have bit
 * people before stay pinned — the preview line never appears twice to one
 * reader, and a URL survives the plain-text conversion WHOLE (html-to-text
 * wraps at 80 columns by default, and a wrapped activation link is a dead
 * one). Props that do not match the schema are a programming error and throw.
 */
import { Text } from "@react-email/components";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EmailLink } from "./components/email-link.js";
import { defineEmailTemplate } from "./email-template.js";
import { renderEmailTemplate } from "./render-email-template.js";

const LONG_URL =
  "https://app.example/account-invitations/01890000-0000-7000-8000-000000000901/accept#token=aaaaaaaabbbbbbbbccccccccdddddddd";

const noticeTemplate = defineEmailTemplate({
  name: "email-templates.render-test-notice",
  description: "A template that exists only to prove the render contract.",
  props: z.object({
    name: z.string().meta({ description: "Who the message greets" }),
    link: z.url().meta({ description: "Where the reader is being sent" }),
  }),
  subject: ({ name }) => `Notice for ${name}`,
  preview: () => "Preview line",
  body: ({ name, link }) => (
    <>
      <Text>{name}, here is the thing.</Text>
      <Text>
        <EmailLink href={link}>{link}</EmailLink>
      </Text>
    </>
  ),
  samples: { named: { name: "Dana", link: LONG_URL } },
});

const previewlessTemplate = defineEmailTemplate({
  name: "email-templates.render-test-previewless",
  description: "A template with no preview line, to prove preview is optional.",
  props: z.object({
    name: z.string().meta({ description: "Who the message greets" }),
  }),
  subject: () => "No preview here",
  body: ({ name }) => <Text>{name}, here is the thing.</Text>,
  samples: { named: { name: "Dana" } },
});

describe("renderEmailTemplate", () => {
  it("renders with the native server TSX loader", () => {
    const rendererUrl = new URL("./render-email-template.tsx", import.meta.url).href;
    const templateUrl = new URL("./email-template.ts", import.meta.url).href;
    const source = `
      import React from "react";
      import { z } from "zod";
      import { renderEmailTemplate } from ${JSON.stringify(rendererUrl)};
      import { defineEmailTemplate } from ${JSON.stringify(templateUrl)};

      const template = defineEmailTemplate({
        name: "email-templates.native-runtime-test",
        description: "A template that proves server TSX rendering works.",
        props: z.object({ message: z.string().meta({ description: "Message" }) }),
        subject: () => "Runtime render",
        body: () => React.createElement("p", null, "runtime rendered"),
        samples: { sample: { message: "runtime rendered" } },
      });

      const rendered = await renderEmailTemplate(template, { message: "runtime rendered" });
      if (!rendered.html.includes("runtime rendered")) process.exitCode = 1;
      else process.stdout.write("rendered");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: undefined },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("rendered");
  });

  it("returns the subject, the preview line and both bodies", async () => {
    const rendered = await renderEmailTemplate(noticeTemplate, {
      name: "Dana",
      link: LONG_URL,
    });

    expect(rendered.subject).toBe("Notice for Dana");
    expect(rendered.preview).toBe("Preview line");
    expect(rendered.html).toContain("<!DOCTYPE");
    // React writes a comment marker between an interpolated value and the
    // literal text beside it, so the HTML holds the sentence in pieces. The
    // text twin is where it reads as one sentence — which is the point.
    expect(rendered.html).toContain("here is the thing.");
    expect(rendered.text).toContain("Dana, here is the thing.");
  });

  it("leaves the preview line out of the text twin", async () => {
    const rendered = await renderEmailTemplate(noticeTemplate, {
      name: "Dana",
      link: LONG_URL,
    });

    expect(rendered.html).toContain("Preview line");
    expect(rendered.text).not.toContain("Preview line");
  });

  it("has no preview when the template declares none", async () => {
    const rendered = await renderEmailTemplate(previewlessTemplate, {
      name: "Dana",
    });

    expect(rendered.preview).toBeUndefined();
    expect(rendered.html).not.toContain("data-skip-in-text");
  });

  it("carries a long url into the text twin unwrapped", async () => {
    const rendered = await renderEmailTemplate(noticeTemplate, {
      name: "Dana",
      link: LONG_URL,
    });

    expect(rendered.text).toContain(LONG_URL);
    for (const line of rendered.text.split("\n")) {
      expect(line.includes(LONG_URL) || !line.includes("#token=")).toBe(true);
    }
  });

  it("throws with the template named when the props do not match", async () => {
    await expect(renderEmailTemplate(noticeTemplate, { name: "Dana", link: "not-a-url" })).rejects.toThrow(
      /email-templates\.render-test-notice/,
    );
  });
});
