import { describe, expect, it } from "vitest";
import { decideWorktreeRemoval, type WorktreeRemovalFacts } from "./worktree-decision.js";

const merged: WorktreeRemovalFacts = {
  primary: false,
  locked: false,
  dirty: false,
  running: false,
  pushed: true,
  mergedPatch: true,
  empty: false,
  idleMinutes: 120,
};

describe("worktree removal", () => {
  it.each([
    [{ primary: true }, "primary"],
    [{ locked: true }, "locked"],
    [{ dirty: true }, "dirty"],
    [{ running: true }, "running-or-unknown"],
    [{ pushed: false }, "unpushed"],
  ] as const)("protects %j after a patch merges", (facts, reason) => {
    expect(decideWorktreeRemoval({ ...merged, ...facts })).toEqual({
      remove: false,
      reason,
    });
  });

  it("keeps unmerged changes and removes a pushed equivalent patch", () => {
    expect(decideWorktreeRemoval(merged)).toEqual({
      remove: true,
      reason: "merged-patch",
    });
    expect(decideWorktreeRemoval({ ...merged, mergedPatch: false }).remove).toBe(false);
  });

  it("requires sixty minutes of idleness for an empty checkout", () => {
    const empty = { ...merged, empty: true, mergedPatch: false };
    expect(decideWorktreeRemoval({ ...empty, idleMinutes: 59.99 }).remove).toBe(false);
    expect(decideWorktreeRemoval({ ...empty, idleMinutes: 60 })).toEqual({
      remove: true,
      reason: "empty-and-idle",
    });
  });
});
