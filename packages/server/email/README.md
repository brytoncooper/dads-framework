# @dads-framework/email

Keep outbound mail code independent of the delivery provider. Callers use
`EmailSender.send()`. The application chooses the driver when it creates
the sender.

## Try it

In a project using Node.js 22 or later, install the example dependencies.

```sh
npm install @dads-framework/email
npm install -D tsx
```

Save this as `example.mts` and run `npx tsx example.mts`.

<!-- dads:check-example -->

```ts
import { CapturedMailbox, createEmailSender } from "@dads-framework/email";

const mailbox = new CapturedMailbox();
const sender = createEmailSender(
  {
    driver: "capture",
    from: "orders@example.com",
    mailbox,
  },
  console,
);
const receipt = await sender.send({
  to: [{ address: "customer@example.com" }],
  subject: "Order ready",
  text: "Order 1042 is ready for pickup.",
});

console.log(receipt.providerMessageId);
console.log(mailbox.list()[0]?.text);
```

The script prints `mail-1` and `Order 1042 is ready for pickup.` from the local mailbox. The capture driver keeps the message in memory and requires no provider account.

The package tests exercise the capture driver and its mailbox outside the starter. [`packages/server/email/src/lib/capture-email-sender.test.ts`](src/lib/capture-email-sender.test.ts)

## Use it

```ts
const receipt = await emailSender.send({
  to: [{ address: "invitee@example.com", name: "Dana Reyes" }],
  subject: "Your invitation",
  text: `Accept your invitation: ${activationLink}`,
});
```

`to` is a list because one message can have many recipients; `cc`, `bcc`,
`replyTo`, `from`, `html`, `attachments`, `headers` and `tags` are optional and
complete the envelope:

```ts
await emailSender.send({
  to: [{ address: "ops@example.com" }],
  cc: [{ address: "audit@example.com" }],
  replyTo: { address: "support@example.com" },
  subject: "Order 1042 is ready",
  text: "Order 1042 is ready for pickup.",
  html: renderedHtml,
  attachments: [
    {
      filename: "packing-slip.pdf",
      contentType: "application/pdf",
      content: pdfBytes,
    },
  ],
  headers: { "X-App-Kind": "order-ready" },
  tags: ["order-ready"],
});
```

`send()` returns an `EmailSendReceipt` — `{ providerMessageId }`, the vendor's
id for the accepted message, or `null` from a driver that never sends. Store it
beside the row that asked for the send; it is the only handle a support
conversation with the vendor has.

Addresses are rendered for the wire by `formatEmailAddress` (`addr`, or
`Name <addr>`, quoted when the name would otherwise break the header). Tags are
plain ASCII labels (`[A-Za-z0-9_-]{1,256}`) for vendor-side delivery reporting.

Call `createEmailSender` once at the application's composition root using
the chosen driver and its credentials. The domain that sends an invitation
or verification email owns the message content.

## Drivers

| `MAIL_DRIVER` | Driver                  | Sends? | Receipt              | Use                                                                                                     |
| ------------- | ----------------------- | ------ | -------------------- | ------------------------------------------------------------------------------------------------------- |
| `log`         | `LogEmailSender`        | No     | `null`               | Default. Records `email.logged` and **withholds** the address and body.                                 |
| `log-verbose` | `VerboseLogEmailSender` | No     | `null`               | A developer's own machine. Renders the whole email into the logs.                                       |
| `capture`     | `CaptureEmailSender`    | No     | the `mail-N` id      | Development. The application can inspect captured messages in memory.                                   |
| `resend`      | `ResendEmailSender`     | Yes    | Resend's message id  | Real delivery. Requires the `resend` SDK and `RESEND_API_KEY`.                                          |
| `mailgun`     | `MailgunEmailSender`    | Yes    | Mailgun's message id | Real delivery. Requires `MAILGUN_API_KEY` + `MAILGUN_DOMAIN`; `MAILGUN_REGION` picks the US or EU host. |

Install the optional SDK with `npm install resend` when using the Resend
driver. The sender loads `resend` lazily on its first send; `@dads-framework/email/templates`
likewise loads `@react-email/render` lazily on first render. If either optional
peer is missing, the call rejects with an actionable `npm install <pkg>` hint.

Attachment BYTES stop at the two non-sending drivers: `capture` and
`log-verbose` keep each attachment's filename, content type and size, never its
content. A base64 blob helps nobody read an email, and a log is the last place
a document belongs.

`log` is the CI and shared-environment default on purpose: bodies carry
one-time invitation and verification tokens, so a full-body log is credential
material. `log-verbose` exists only so a developer can read the email — and
click the link — without a mail vendor. Never set it anywhere other people's
tokens flow.

`capture` makes the same trade for the development mail page instead of the
logs: the mailbox lives in the API process's memory, so captured mail is lost
on restart, and it must never run outside development either.

For tests, import `FakeEmailSender` from `@dads-framework/email/testing`
and assert on `sent`; it never reaches a driver at all.

## Adding a driver

Add a driver at the composition boundary using the shared sender contract.

1. Add `<vendor>-email-sender.ts` — a class implementing `EmailSender` that
   translates `EmailMessage` into the vendor's call and throws on rejection.
   Follow `resend-email-sender.ts`.
2. Add the name to `EmailSenderDriver` and a branch in `createEmailSender`.
   Fail loudly there when a required credential is missing, the way `resend`
   does — a misconfigured mailer must not boot and silently drop email.
3. Export the class from `src/index.ts`.
4. Surface the vendor SDK as a dependency in the plan/PR (NEVER rule 4), widen
   the application’s driver configuration,
   and document the new env vars in the application’s example environment file.

Nothing else moves: no caller, no domain, no message body.

`mailgun` is the worked example of all four steps, and of the case where the
vendor needs no SDK at all: `mailgun-email-sender.ts` is one multipart `fetch`,
the envelope translation lives in the pure `logic/build-mailgun-form.ts`, and
`fetch` is injected so the tests read the exact request rather than a vendor's
mock.

## What it refuses to do

The `log` driver withholds addresses and message bodies to protect recipients
and one-time tokens. Keep the `capture` and `log-verbose` drivers in
development environments.

## Contract

Import the sender and message contracts from
`@dads-framework/email/core` when implementing or accepting a sender.
Import the capturing fake and conformance cases from
`@dads-framework/email/core/testing`. Both entry points work without the
Resend SDK. Resend and Mailgun run the shared sender tests with in-memory
transport responses.

After installing the dependencies from [Try it](#try-it), save this as
`example.mts` and run `npx tsx example.mts`.

<!-- dads:check-example -->

```ts
import type { EmailSender } from "@dads-framework/email/core";
import { FakeEmailSender } from "@dads-framework/email/core/testing";

async function notify(sender: EmailSender) {
  return sender.send({
    to: [{ address: "customer@example.com" }],
    subject: "Order ready",
    text: "Order 1042 is ready for pickup.",
  });
}

const sender = new FakeEmailSender();
const receipt = await notify(sender);
console.log(receipt.providerMessageId, sender.sent[0]?.subject);
```

The script prints `fake-1 Order ready`. In a test, inspect `sent` for the message your feature submitted.

The starter implements the `EmailSender` contract with a local spool that writes each message to a JSON file. [`apps/kit-workbench/assembly/local-mail.ts`](../../../apps/kit-workbench/assembly/local-mail.ts)
