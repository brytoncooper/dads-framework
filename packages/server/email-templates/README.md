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

## Paired-body rendering

The default `renderEmailTemplate` uses React Email. A caller can inject an
`EmailDocumentRenderer` with `createEmailTemplateRenderer` for another rendering
context. The shared laws run the delivery renderer and an independent test
preview that uses React server markup and projects plain text from its DOM.
They cover parsed props, visible content, whole links, and preview omission
from plain text. Delivery-client markup and branding remain specific to the
production renderer.
