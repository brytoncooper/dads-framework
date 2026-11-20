import { presentToken } from "./present-token.js";

export type ReadConsistencyDecision =
  | { readonly kind: "fully-consistent" }
  | { readonly kind: "at-least-as-fresh"; readonly token: string }
  | { readonly kind: "minimize-latency" };

export function resolveReadConsistency(input: {
  readonly adapterConsistency: "minimize-latency" | "fully-consistent";
  readonly queryConsistency?: "fully-consistent";
  readonly queryToken?: string;
  readonly requestToken?: string;
}): ReadConsistencyDecision {
  if (
    input.adapterConsistency === "fully-consistent" ||
    input.queryConsistency === "fully-consistent"
  ) {
    return { kind: "fully-consistent" };
  }
  const token =
    presentToken(input.queryToken) ?? presentToken(input.requestToken);
  if (token !== undefined) {
    return { kind: "at-least-as-fresh", token };
  }
  return { kind: "minimize-latency" };
}
