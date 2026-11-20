/**
 * Testing entry point (`@dads-framework/job-queue/testing`) — the inspectable
 * fake only, kept out of the main barrel so production code cannot import it
 * (docs/testing/seeders.md).
 */
export { FakeJobQueue, type EnqueuedJob } from "./core/testing.js";
