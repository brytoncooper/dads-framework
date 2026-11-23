import { emailSenderConformance } from "../core/email-sender-conformance.js";
/**
 * The Mailgun driver is a vendor adapter with no SDK behind it, so the tests
 * inject `fetch` and read the request Mailgun would have received: the right
 * regional host, Basic auth built from the key, and the envelope as multipart
 * form fields. The rejection path is pinned too, because a mailer that leaks
 * an API key or a recipient into an error message leaks it into every log.
 */
import { describe, expect, it } from "vitest";
import { MailgunEmailSender } from "./mailgun-email-sender.js";

type CapturedRequest = { readonly url: string; readonly init: RequestInit };

const MESSAGE = {
  to: [{ address: "invitee@example.test" }],
  subject: "Your invitation",
  text: "Accept your invitation.",
};

function acceptedResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The requested URL, whichever of `fetch`'s three input forms was used. */
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Every value posted under one field name, failing loudly on a file entry. */
function textValues(form: FormData, field: string): string[] {
  return form.getAll(field).map((entry) => {
    if (typeof entry !== "string") {
      throw new Error(`${field} carried a file, not text`);
    }
    return entry;
  });
}

/** A `fetch` that answers with one canned response and records what it was asked. */
function captureFetch(response: Response): {
  readonly fetchImpl: typeof fetch;
  readonly calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: requestUrl(input), init: init ?? {} });
    return Promise.resolve(response);
  };
  return { fetchImpl, calls };
}

describe("MailgunEmailSender", () => {
  it("posts to the US messages endpoint with Basic auth built from the key", async () => {
    const { fetchImpl, calls } = captureFetch(acceptedResponse({ id: "<20260911.1@example.test>" }));
    const sender = new MailgunEmailSender(
      {
        apiKey: "key-secret",
        domain: "mail.example.test",
        region: "us",
        from: "Example App <no-reply@example.test>",
      },
      fetchImpl,
    );

    await sender.send(MESSAGE);

    const [call] = calls;
    expect(call?.url).toBe("https://api.mailgun.net/v3/mail.example.test/messages");
    expect(call?.init.method).toBe("POST");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("api:key-secret").toString("base64")}`);
  });

  it("posts to the EU host when the account lives in the EU region", async () => {
    const { fetchImpl, calls } = captureFetch(acceptedResponse({ id: "eu-1" }));
    const sender = new MailgunEmailSender(
      {
        apiKey: "key-secret",
        domain: "mail.example.test",
        region: "eu",
        from: "Example App <no-reply@example.test>",
      },
      fetchImpl,
    );

    await sender.send(MESSAGE);

    expect(calls[0]?.url).toBe("https://api.eu.mailgun.net/v3/mail.example.test/messages");
  });

  it("sends the envelope as multipart form fields", async () => {
    const { fetchImpl, calls } = captureFetch(acceptedResponse({ id: "id-1" }));
    const sender = new MailgunEmailSender(
      {
        apiKey: "key-secret",
        domain: "mail.example.test",
        region: "us",
        from: "Example App <no-reply@example.test>",
      },
      fetchImpl,
    );

    await sender.send({
      ...MESSAGE,
      to: [{ address: "one@example.test" }, { address: "two@example.test" }],
      tags: ["invitation"],
    });

    const body = calls[0]?.init.body;
    if (!(body instanceof FormData)) throw new Error("expected a FormData body");
    expect(textValues(body, "to")).toEqual(["one@example.test", "two@example.test"]);
    expect(textValues(body, "o:tag")).toEqual(["invitation"]);
    expect(textValues(body, "from")).toEqual(["Example App <no-reply@example.test>"]);
  });

  it("returns the vendor's message id as the receipt", async () => {
    const { fetchImpl } = captureFetch(acceptedResponse({ id: "<20260911.2@example.test>", message: "Queued" }));
    const sender = new MailgunEmailSender(
      {
        apiKey: "key-secret",
        domain: "mail.example.test",
        region: "us",
        from: "Example App <no-reply@example.test>",
      },
      fetchImpl,
    );

    await expect(sender.send(MESSAGE)).resolves.toEqual({
      providerMessageId: "<20260911.2@example.test>",
    });
  });

  it("reports a null receipt when Mailgun accepts without naming an id", async () => {
    const { fetchImpl } = captureFetch(new Response("Queued. Thank you.", { status: 200 }));
    const sender = new MailgunEmailSender(
      {
        apiKey: "key-secret",
        domain: "mail.example.test",
        region: "us",
        from: "Example App <no-reply@example.test>",
      },
      fetchImpl,
    );

    await expect(sender.send(MESSAGE)).resolves.toEqual({
      providerMessageId: null,
    });
  });

  it("throws on rejection without putting the key or the recipient in the message", async () => {
    const { fetchImpl } = captureFetch(new Response("domain not found: mail.example.test", { status: 404 }));
    const sender = new MailgunEmailSender(
      {
        apiKey: "key-secret",
        domain: "mail.example.test",
        region: "us",
        from: "Example App <no-reply@example.test>",
      },
      fetchImpl,
    );

    const failure = await sender.send(MESSAGE).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("404");
    expect(message).not.toContain("key-secret");
    expect(message).not.toContain("invitee@example.test");
  });

  it("truncates a long rejection body so a vendor error page cannot fill the logs", async () => {
    const { fetchImpl } = captureFetch(new Response("x".repeat(5_000), { status: 500 }));
    const sender = new MailgunEmailSender(
      {
        apiKey: "key-secret",
        domain: "mail.example.test",
        region: "us",
        from: "Example App <no-reply@example.test>",
      },
      fetchImpl,
    );

    const failure = await sender.send(MESSAGE).catch((error: unknown) => error);

    const message = failure instanceof Error ? failure.message : "";
    expect(message.length).toBeLessThanOrEqual(600);
  });
});

describe("EmailSender conformance against Mailgun", () => {
  it.each(emailSenderConformance)("$name", async ({ run }) => {
    await run((accepted) => {
      const acceptedId = "mailgun-receipt";
      const response = accepted
        ? acceptedResponse({ id: acceptedId })
        : new Response(JSON.stringify({ message: "Refused" }), { status: 400 });
      const { fetchImpl, calls } = captureFetch(response);
      return {
        sender: new MailgunEmailSender(
          {
            apiKey: "test-key",
            domain: "mail.example.test",
            region: "us",
            from: "sender@example.test",
          },
          fetchImpl,
        ),
        acceptedId,
        submittedEnvelope() {
          const body = calls[0]?.init.body;
          if (!(body instanceof FormData)) throw new Error("Expected form data");
          return {
            to: textValues(body, "to"),
            subject: body.get("subject"),
            text: body.get("text"),
            html: body.get("html"),
          };
        },
      };
    });
  });
});
