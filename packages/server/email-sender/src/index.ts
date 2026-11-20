export {
  EmailSender,
  type EmailAddress,
  type EmailAttachment,
  type EmailMessage,
  type EmailSendReceipt,
} from "@dads-framework/email-sender-core";
export {
  formatEmailAddress,
  formatEmailAddresses,
} from "./lib/logic/format-email-address.js";
export {
  describeEmailMessage,
  type EmailMessageDescription,
} from "./lib/logic/describe-email-message.js";
export { LogEmailSender } from "./lib/log-email-sender.js";
export { VerboseLogEmailSender } from "./lib/verbose-log-email-sender.js";
export { CaptureEmailSender } from "./lib/capture-email-sender.js";
export {
  CapturedMailbox,
  type CapturedAttachment,
  type CapturedEmail,
  type CapturedMailboxOptions,
} from "./lib/captured-mailbox.js";
export { ResendEmailSender } from "./lib/resend-email-sender.js";
export {
  MailgunEmailSender,
  type MailgunEmailSenderOptions,
  type MailgunRegion,
} from "./lib/mailgun-email-sender.js";
export { buildMailgunForm } from "./lib/logic/build-mailgun-form.js";
export {
  createEmailSender,
  type CreateEmailSenderOptions,
  type EmailSenderDriver,
} from "./lib/create-email-sender.js";
