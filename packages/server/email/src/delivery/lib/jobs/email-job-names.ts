/**
 * The two job names, apart from the definitions that implement them.
 *
 * The facade enqueues `email.deliver` but has no business holding the job —
 * the job holds the mutation, which holds the store. A name is all either
 * side needs, and keeping it here is what stops that from becoming a cycle.
 */

/** Delivers one claimed outbound email. Payload: `{ outboundEmailId }`. */
export const EMAIL_DELIVER_JOB = "email.deliver";

/** Picks up what is due and fails stale claims. Runs every minute. */
export const EMAIL_SWEEP_JOB = "email.sweep";
