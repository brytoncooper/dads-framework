/**
 * `buildMailgunForm` is the whole translation from the shared envelope into
 * Mailgun's multipart vocabulary, so every field the envelope carries is
 * asserted here rather than through the driver — a pure function is the one
 * place a missing `bcc` or a dropped tag can be seen without a network call.
 */
import { describe, expect, it } from "vitest";
import { buildMailgunForm } from "./build-mailgun-form.js";

const DEFAULT_FROM = "Example App <no-reply@example.test>";

/** Every value posted under one field name, failing loudly on a file entry. */
function textValues(form: FormData, field: string): string[] {
  return form.getAll(field).map((entry) => {
    if (typeof entry !== "string") {
      throw new Error(`${field} carried a file, not text`);
    }
    return entry;
  });
}

describe("buildMailgunForm", () => {
  it("sends the configured from address when the message names none", () => {
    const form = buildMailgunForm({ to: [{ address: "a@b.test" }], subject: "Hello", text: "Body" }, DEFAULT_FROM);

    expect(textValues(form, "from")).toEqual([DEFAULT_FROM]);
    expect(textValues(form, "subject")).toEqual(["Hello"]);
    expect(textValues(form, "text")).toEqual(["Body"]);
    expect(form.has("html")).toBe(false);
  });

  it("prefers the message's own from address", () => {
    const form = buildMailgunForm(
      {
        to: [{ address: "a@b.test" }],
        from: { address: "orders@example.test", name: "Order desk" },
        subject: "Hello",
        text: "Body",
      },
      DEFAULT_FROM,
    );

    expect(textValues(form, "from")).toEqual(["Order desk <orders@example.test>"]);
  });

  it("repeats a field per recipient rather than joining them", () => {
    const form = buildMailgunForm(
      {
        to: [{ address: "first@b.test", name: "First Person" }, { address: "second@b.test" }],
        cc: [{ address: "cc@b.test" }],
        bcc: [{ address: "bcc@b.test" }],
        subject: "Hello",
        text: "Body",
      },
      DEFAULT_FROM,
    );

    expect(textValues(form, "to")).toEqual(["First Person <first@b.test>", "second@b.test"]);
    expect(textValues(form, "cc")).toEqual(["cc@b.test"]);
    expect(textValues(form, "bcc")).toEqual(["bcc@b.test"]);
  });

  it("carries the HTML body beside the text twin", () => {
    const form = buildMailgunForm(
      {
        to: [{ address: "a@b.test" }],
        subject: "Hello",
        text: "Body",
        html: "<p>Body</p>",
      },
      DEFAULT_FROM,
    );

    expect(textValues(form, "html")).toEqual(["<p>Body</p>"]);
  });

  it("sends reply-to as the header Mailgun passes through", () => {
    const form = buildMailgunForm(
      {
        to: [{ address: "a@b.test" }],
        replyTo: { address: "support@example.test" },
        subject: "Hello",
        text: "Body",
      },
      DEFAULT_FROM,
    );

    expect(textValues(form, "h:Reply-To")).toEqual(["support@example.test"]);
  });

  it("prefixes each extra header with h: verbatim", () => {
    const form = buildMailgunForm(
      {
        to: [{ address: "a@b.test" }],
        subject: "Hello",
        text: "Body",
        headers: { "X-Example-Kind": "order-ready" },
      },
      DEFAULT_FROM,
    );

    expect(textValues(form, "h:X-Example-Kind")).toEqual(["order-ready"]);
  });

  it("repeats o:tag once per label", () => {
    const form = buildMailgunForm(
      {
        to: [{ address: "a@b.test" }],
        subject: "Hello",
        text: "Body",
        tags: ["order-ready", "test-send"],
      },
      DEFAULT_FROM,
    );

    expect(textValues(form, "o:tag")).toEqual(["order-ready", "test-send"]);
  });

  it("attaches each file under its own filename and content type", async () => {
    const form = buildMailgunForm(
      {
        to: [{ address: "a@b.test" }],
        subject: "Hello",
        text: "Body",
        attachments: [
          {
            filename: "packing-slip.pdf",
            contentType: "application/pdf",
            content: new TextEncoder().encode("slip"),
          },
        ],
      },
      DEFAULT_FROM,
    );

    const attached = form.getAll("attachment");
    expect(attached).toHaveLength(1);
    const [file] = attached;
    if (!(file instanceof File)) throw new Error("expected an attached File");
    expect(file.name).toBe("packing-slip.pdf");
    expect(file.type).toBe("application/pdf");
    expect(await file.text()).toBe("slip");
  });
});
