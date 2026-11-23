/**
 * Per-request work (`@dads-framework/core/runtime/request-work`): what a request cost, and
 * answering a question it repeats once.
 *
 * A leaf on purpose: the postgres kit and the authorization kit both charge
 * into it, and neither may depend on the HTTP kit. See
 * `docs/architecture/observability.md`.
 */
export {
  answeringEachQuestionOnce,
  AnswersOncePerScope,
  OneValuePerScope,
  outsideRequestAnswers,
} from "./lib/answer-once.js";
export {
  type AuthorizationReadFreshness,
  type AuthorizationWarning,
  beginRequestWork,
  countAuthorizationCheck,
  countAuthorizationLookupSize,
  countAuthorizationReadFreshness,
  countDatabaseQuery,
  currentRequestWork,
  measureWork,
  noteAuthorizationWarning,
  requestWorkOf,
  type RequestWorkTally,
} from "./lib/request-work-tally.js";
export {
  chargeAuthorizationCheck,
  chargeDatabaseQuery,
} from "./lib/charge-request-work.js";
