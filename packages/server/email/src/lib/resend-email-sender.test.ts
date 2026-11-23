import { afterEach, describe, it, vi } from "vitest";

import { emailSenderConformance } from "../core/email-sender-conformance.js";

import { ResendEmailSender } from "./resend-email-sender.js";

afterEach(() => vi.unstubAllGlobals());

describe("EmailSender conformance against Resend", () => {
  it.each(emailSenderConformance)("$name", async ({ run }) => {
    await run((accepted) => {
      const acceptedId = "resend-receipt";
      let sent: unknown;
      const transport: typeof fetch = (_input, init) => {
        const body = init?.body;
        if (typeof body !== "string") throw new Error("Expected a JSON body");
        sent = JSON.parse(body);
        return Promise.resolve(
          new Response(
            JSON.stringify(accepted ? { id: acceptedId } : { name: "validation_error", message: "Refused" }),
            {
              status: accepted ? 200 : 400,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      };
      vi.stubGlobal("fetch", transport);
      return {
        sender: new ResendEmailSender("test-key", "sender@example.test"),
        acceptedId,
        submittedEnvelope() {
          if (typeof sent !== "object" || sent === null) return sent;
          const { from, ...message } = Object.fromEntries(Object.entries(sent));
          void from;
          return message;
        },
      };
    });
  });
});
