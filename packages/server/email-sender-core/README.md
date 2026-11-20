# @dads-framework/email-sender-core

Accept an `EmailSender` to send a message without choosing a transport. Select
the transport in the application's composition root using
[`@dads-framework/email-sender`](../email-sender/README.md).

In application tests, use the capturing sender from
`@dads-framework/email-sender-core/testing` to assert what would be sent
without delivering mail.

## Provider contract

Senders accept an envelope and message bodies. Vendors that accept the message
return a receipt with a provider ID. Failed sends reject. The testing export
contains a capturing stand-in and named conformance cases.
