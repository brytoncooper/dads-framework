/**
 * Testing entry point (`@dads-framework/request-work/testing`).
 *
 * `measureRequestWork` is how a test asks "what did this cost" without an HTTP
 * request: it is the same accounting production uses, so a budget asserted
 * here is a budget asserted against the real counters rather than a stand-in.
 * Kept out of the main barrel so production code cannot reach for it.
 */
export { measureRequestWork } from "./lib/measure-request-work.js";
