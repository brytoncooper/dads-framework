/**
 * Testing entry point (`@dads-framework/email/delivery/testing`) — factories,
 * scenarios and fakes, kept out of the main barrel so production code cannot import
 * them (docs/testing/seeders.md).
 */
export {
  makeOutboundEmail,
  makeOutboundEmailDocument,
  outboundEmailId,
} from "./lib/testing/outbound-email.factory.js";
export { seedQueuedEmailWithDocuments } from "./lib/testing/queued-email.seeder.js";
export {
  FakeEmailDelivery,
  type FakeEnqueuedEmail,
  type FakeSentEmail,
} from "./lib/testing/fake-email-delivery.js";
export {
  FakeOutboundEmailStore,
  type FakeOutboundEmailRow,
} from "./lib/testing/fake-outbound-email-store.js";
