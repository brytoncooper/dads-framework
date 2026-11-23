/**
 * What: a per-checkout name for the files test runs leave in tmpdir. Why: two
 * worktrees on one machine must not share a migrated template Postgres.
 */
import { describe, expect, it } from "vitest";
import { currentWorktreeIdentity, currentWorktreePath, worktreeIdentity } from "./worktree-identity.js";

describe("worktreeIdentity", () => {
  it("is 24 hex characters", () => {
    expect(worktreeIdentity("/checkouts/command")).toMatch(/^[0-9a-f]{24}$/);
  });

  it("is stable for the same path", () => {
    expect(worktreeIdentity("/checkouts/command")).toBe(worktreeIdentity("/checkouts/command"));
  });

  it("differs for a different path, which is the whole point", () => {
    expect(worktreeIdentity("/checkouts/command")).not.toBe(
      worktreeIdentity("/checkouts/command/.claude/worktrees/dev-slots"),
    );
  });
});

describe("currentWorktreeIdentity", () => {
  it("is the identity of the workspace root this process runs in", () => {
    expect(currentWorktreeIdentity()).toBe(worktreeIdentity(currentWorktreePath()));
  });
});
