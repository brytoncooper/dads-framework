# @dads-framework/email-templates — email rendering

Turns a declarative email template into the HTML and plain-text pair a message
carries. Templates are React components built from `@react-email/components`,
which handles the table layout and inline styling that Outlook and Gmail still
require; `renderEmailTemplate` produces both bodies from one definition, so the
text twin can never drift from the HTML.

This kit renders. It does not send (`@dads-framework/email-sender`) and it does not
decide when to send (`@dads-framework/email-delivery`). Templates themselves belong
to the domain that owns the words, not to this library.

The default layout uses a neutral color palette and makes no image requests.
Supply an optional `EmailBranding` object to `renderEmailTemplate`,
`createEmailTemplateRegistry`, or the `EmailLayout` component to display an
application's header or footer logo. Each image specifies an HTTPS URL,
alternative text, and display dimensions in pixels.

## Try it

In a project using Node.js 22 or later, install the example dependencies.

```sh
npm install @dads-framework/email-templates react@19 react-dom@19 zod@4
npm install -D tsx
```

Save this as `example.mts` and run `npx tsx example.mts`.

<!-- dads:check-example -->

```ts
import { createElement } from "react";
import { z } from "zod";
import {
  defineEmailTemplate,
  EmailText,
  renderEmailTemplate,
} from "@dads-framework/email-templates";

const template = defineEmailTemplate({
  name: "orders.pickup-ready",
  description: "Tells a customer that their order is ready for pickup.",
  props: z.object({
    order: z.string().meta({ description: "The customer's order number" }),
  }),
  subject: ({ order }) => `Order ${order} is ready`,
  body: ({ order }) =>
    createElement(EmailText, {
      children: `Order ${order} is ready for pickup.`,
    }),
  samples: { example: { order: "1042" } },
});

const message = await renderEmailTemplate(template, { order: "1042" });
console.log(message.subject);
console.log(message.text.trim());
console.log(message.html.includes("Order 1042 is ready for pickup."));
```

The script prints the subject, the plain-text body, and `true` for the same text in the rendered HTML. Rendering runs locally.

## Render a message

Define the React template and its property schema in the owning domain. Pass
the template and properties to `renderEmailTemplate(template, props)`, then
give its `html` and `text` to your delivery code. Set optional branding at
composition so every template uses the same logos and dimensions.

## Paired-body rendering

The default `renderEmailTemplate` uses React Email. A caller can inject an
`EmailDocumentRenderer` with `createEmailTemplateRenderer` for another rendering
context. The shared laws run the delivery renderer and an independent test
preview that uses React server markup and projects plain text from its DOM.
They cover parsed props, visible content, whole links, and preview omission
from plain text. Delivery-client markup and branding remain specific to the
production renderer.
