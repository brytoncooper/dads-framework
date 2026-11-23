/**
 * Public surface of `@dads-framework/email/delivery` — the outbound-email row,
 * the facade that writes it, the jobs that deliver it, and the operator
 * actions over it. Transport belongs to `@dads-framework/email/core` and
 * rendering to `@dads-framework/email/templates`.
 */
export {
  OUTBOUND_EMAIL_STATUS_VALUES,
  outboundEmailIdSchema,
  type OutboundEmailId,
  type OutboundEmailStatus,
} from "./lib/outbound-email-status.js";
export {
  emailEnvelopeSchema,
  type EmailEnvelope,
} from "./lib/email-envelope.js";
export {
  queuedEmailAttachmentSchema,
  queuedEmailAttachmentsSchema,
  SEND_OUTCOME_UNKNOWN_ERROR,
  type QueuedEmailAttachment,
  type EmailFailurePolicy,
  type LoadEmailAttachment,
} from "./lib/queued-email-attachment.js";
export { installQueuedEmailAttachmentsV1 } from "./lib/database/schema/install-queued-email-attachments-v1.js";
export { installEmailDeliverySchemaV1 } from "./lib/database/schema/install-email-delivery-schema-v1.js";
export { outboundEmailDocument } from "./lib/database/generated-tables/outbound-email-documents.tables.js";
export { outboundEmail } from "./lib/database/generated-tables/outbound-emails.tables.js";
export {
  EmailDelivery,
  type EmailDeliveryLog,
  type EnqueueEmailOptions,
  type EnqueuedEmail,
  type SendNowOptions,
  type SentEmail,
} from "./lib/email-delivery.js";
export {
  LiveEmailDelivery,
  type LiveEmailDeliveryDependencies,
} from "./lib/live-email-delivery.js";
export type {
  EmailTemplate,
  EmailTemplateCatalog,
  RenderEmailTemplate,
  RenderedEmailContent,
} from "./lib/email-template-port.js";
export {
  EMAIL_DELIVER_JOB,
  EMAIL_SWEEP_JOB,
} from "./lib/jobs/email-job-names.js";
export {
  OutboundEmailStore,
  type ClaimedOutboundEmail,
  type ImmediateOutboundEmail,
  type NewOutboundEmail,
  type OutboundEmailTx,
} from "./lib/database/outbound-email-store.js";
export {
  DrizzleOutboundEmailStore,
  STALE_CLAIM_ERROR,
} from "./lib/database/drizzle-outbound-email-store.js";
export {
  DrizzleOutboundEmailLog,
  type OutboundEmailLogEntry,
  type OutboundEmailLogPage,
  type OutboundEmailLogQuery,
} from "./lib/database/drizzle-outbound-email-log.js";
export {
  MAX_DELIVERY_ATTEMPTS,
  nextAttemptAt,
} from "./lib/logic/next-attempt-at.js";
export {
  MAX_DELIVERY_ERROR_SUMMARY_LENGTH,
  deliveryErrorName,
  summarizeDeliveryError,
} from "./lib/logic/summarize-delivery-error.js";
export {
  SendTestEmail,
  TEST_SEND_TAG,
  type SendTestEmailDependencies,
  type SendTestEmailInput,
  type SendTestEmailReport,
} from "./lib/mutations/send-test-email.mutation.js";
export {
  RetryFailedOutboundEmails,
  type RetryFailedOutboundEmailsDependencies,
  type RetryFailedOutboundEmailsInput,
  type RetryFailedOutboundEmailsReport,
} from "./lib/mutations/retry-failed-outbound-emails.mutation.js";
export {
  createEmailDelivery,
  type CreateEmailDeliveryOptions,
} from "./lib/create-email-delivery.js";
export {
  composeEmailDelivery,
  createEmailDeliveryJobs,
  type AssembledEmailDelivery,
  type EmailDeliveryDeps,
  type EmailDeliveryJobDependencies,
} from "./lib/compose-email-delivery.js";
