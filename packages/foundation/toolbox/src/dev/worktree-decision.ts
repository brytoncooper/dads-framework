/** Git and runtime facts collected immediately before a removal decision. */
export type WorktreeRemovalFacts = {
  readonly primary: boolean;
  readonly locked: boolean;
  readonly dirty: boolean;
  readonly running: boolean;
  readonly pushed: boolean;
  readonly mergedPatch: boolean;
  readonly empty: boolean;
  readonly idleMinutes: number;
};

type RemovalReason = "merged-patch" | "empty-and-idle";
type KeepReason = "primary" | "locked" | "dirty" | "running-or-unknown" | "unpushed" | "active-or-unmerged";

/** Decide from observed facts. The caller still removes through Git without force. */
export function decideWorktreeRemoval(
  facts: WorktreeRemovalFacts,
): { readonly remove: true; readonly reason: RemovalReason } | { readonly remove: false; readonly reason: KeepReason } {
  if (facts.primary) return { remove: false, reason: "primary" };
  if (facts.locked) return { remove: false, reason: "locked" };
  if (facts.dirty) return { remove: false, reason: "dirty" };
  if (facts.running) return { remove: false, reason: "running-or-unknown" };
  if (!facts.pushed) return { remove: false, reason: "unpushed" };
  if (facts.empty && facts.idleMinutes < 60) return { remove: false, reason: "active-or-unmerged" };
  if (facts.empty) return { remove: true, reason: "empty-and-idle" };
  if (facts.mergedPatch) return { remove: true, reason: "merged-patch" };
  return { remove: false, reason: "active-or-unmerged" };
}
