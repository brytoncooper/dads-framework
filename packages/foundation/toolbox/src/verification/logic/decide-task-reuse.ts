import type { VerificationReceiptLookup } from "../receipt-store.js";
import type {
  VerificationTaskDefinition,
  VerificationTaskRecommendation,
} from "../verification-contract.js";

export type TaskReuseDecision = {
  readonly decision: "execute" | "reuse";
  readonly reason: string;
};

export function decideTaskReuse(input: {
  readonly full: boolean;
  readonly cacheOff: boolean;
  readonly task: VerificationTaskDefinition;
  readonly recommendation: VerificationTaskRecommendation;
  readonly receipt: VerificationReceiptLookup;
}): TaskReuseDecision {
  if (input.full) {
    return { decision: "execute", reason: "Full verification disables reuse." };
  }
  if (input.cacheOff) {
    return {
      decision: "execute",
      reason: "The cache is off: CI is set or --no-cache was passed.",
    };
  }
  if (input.task.execution.kind !== "controlled-node") {
    return {
      decision: "execute",
      reason: "Shell and live verification tasks are never reused.",
    };
  }
  if (input.task.reusePolicy !== "candidate") {
    return {
      decision: "execute",
      reason: "This task is configured to execute every time.",
    };
  }
  if (
    input.recommendation.state !== "pending-provider" &&
    input.recommendation.state !== "reuse-candidate"
  ) {
    return {
      decision: "execute",
      reason: "The task's own verification inputs changed or scope is unknown.",
    };
  }
  if (input.receipt.status === "match") {
    return {
      decision: "reuse",
      reason: "Exact controlled inputs match a prior successful receipt.",
    };
  }
  return {
    decision: "execute",
    reason:
      input.receipt.status === "invalid"
        ? `Prior evidence is invalid: ${input.receipt.reason}`
        : "No matching successful receipt exists.",
  };
}
