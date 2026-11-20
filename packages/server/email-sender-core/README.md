# @dads-framework/email-sender-core

Accept an `EmailSender` to send a message without choosing a transport. Select
the transport in the application's composition root using
[`@dads-framework/email-sender`](../email-sender/README.md).

In application tests, use the capturing sender from
`@dads-framework/email-sender-core/testing` to assert what would be sent
without delivering mail.

## Try it

In a project using Node.js 22 or later, install the example dependencies.

```sh
npm install @dads-framework/email-sender-core
npm install -D tsx
```

Save this as `example.mts` and run `npx tsx example.mts`.

<!-- dads:check-example -->

```ts
import type { EmailSender } from "@dads-framework/email-sender-core";
import { FakeEmailSender } from "@dads-framework/email-sender-core/testing";

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

## Provider contract

Senders accept an envelope and message bodies. Vendors that accept the message
return a receipt with a provider ID. Failed sends reject. The testing export
contains a capturing stand-in and named conformance cases.
