/**
 * The flags that step around the gate.
 *
 * The commit-hook bypass is assembled from its parts, and `hatch-names.ts`
 * explains the move at length: a reading that counts the literal text of a
 * bypass cannot tell an occurrence from a quotation. This repository's own
 * shell guard denies the flag by naming it, its README names it again, and a
 * rule that fired on the rule forbidding it is the helicopter dad the plan
 * warns about. The force flags need no such care, because nothing in this
 * package writes one and the reading that looks for them reads only workflows.
 *
 * They are ordinary strings by the time a signal sees them.
 */

/** The flag that tells git to skip the hooks. */
export const COMMIT_HOOK_BYPASS = ["--no", "verify"].join("-");

/** A push that overwrites a branch's history rather than adding to it. */
export const FORCE_PUSH = /\bgit\s+push\b[^\n;&|]*(?:--force|\s-f\b)/;

/** The branch names a repository defaults to, which a force push must not take. */
export const DEFAULT_BRANCH = /\b(?:origin\/)?(?:main|master)\b/;
