/**
 * The description is what the default log driver is allowed to write, so the
 * load-bearing assertion is the negative one: counts and flags survive, and
 * no address, subject, body, header value, tag, or attachment byte does.
 */
import { describe, expect, it } from "vitest";
import { describeEmailMessage } from "./describe-email-message.js";

describe("describeEmailMessage", () => {
  it("counts an envelope without optional parts", () => {
    expect(
      describeEmailMessage({
        to: [{ address: "alice@example.com" }],
        subject: "Your invitation",
        text: "secret invitation token",
      }),
    ).toEqual({
      recipientCount: 1,
      ccCount: 0,
      bccCount: 0,
      attachmentCount: 0,
      tagCount: 0,
      headerCount: 0,
      hasHtml: false,
      hasReplyTo: false,
    });
  });

  it("counts every optional part of a full envelope", () => {
    expect(
      describeEmailMessage({
        to: [{ address: "a@example.com" }, { address: "b@example.com" }],
        cc: [{ address: "c@example.com" }],
        bcc: [{ address: "d@example.com" }, { address: "e@example.com" }],
        replyTo: { address: "reply@example.com" },
        subject: "s",
        text: "t",
        html: "<p>t</p>",
        attachments: [
          {
            filename: "packing-slip.pdf",
            contentType: "application/pdf",
            content: Uint8Array.from([1, 2, 3]),
          },
        ],
        headers: { "X-Example-Kind": "invitation" },
        tags: ["invitation", "test-send"],
      }),
    ).toEqual({
      recipientCount: 2,
      ccCount: 1,
      bccCount: 2,
      attachmentCount: 1,
      tagCount: 2,
      headerCount: 1,
      hasHtml: true,
      hasReplyTo: true,
    });
  });

  it("never carries an address, a body, a header value, a tag, or bytes", () => {
    const described = JSON.stringify(
      describeEmailMessage({
        to: [{ address: "alice@example.com", name: "Alice" }],
        replyTo: { address: "reply@example.com" },
        subject: "Your invitation",
        text: "Accept it: http://localhost:4200/x#token=secret-token",
        html: "<p>secret-token</p>",
        attachments: [
          {
            filename: "packing-slip.pdf",
            contentType: "application/pdf",
            content: Uint8Array.from([104, 105]),
          },
        ],
        headers: { "X-Example-Kind": "invitation" },
        tags: ["invitation"],
      }),
    );

    for (const secret of [
      "alice@example.com",
      "Alice",
      "reply@example.com",
      "Your invitation",
      "secret-token",
      "packing-slip.pdf",
      "application/pdf",
      "invitation",
      "104",
    ]) {
      expect(described).not.toContain(secret);
    }
  });
});
