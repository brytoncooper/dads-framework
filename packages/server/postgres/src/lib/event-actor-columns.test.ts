import { describe, expect, it } from "vitest";
import { eventActorColumns } from "./event-actor-columns.js";

/**
 * The point of the split-column shape: a system actor is never written as a
 * user, and a user actor never leaves a stray system name behind. Both halves
 * are asserted because the bug this replaces would be a copy that set one
 * column and forgot to null the other.
 */
describe("eventActorColumns", () => {
  it("writes a human actor as a user id and nothing else", () => {
    expect(eventActorColumns({ type: "USER", userId: "user_sam" })).toEqual({
      actorType: "USER",
      actorUserId: "user_sam",
      actorSystem: null,
    });
  });

  it("writes a system actor by name without borrowing a user id", () => {
    expect(eventActorColumns({ type: "SYSTEM", system: "scim-sync" })).toEqual({
      actorType: "SYSTEM",
      actorUserId: null,
      actorSystem: "scim-sync",
    });
  });
});
