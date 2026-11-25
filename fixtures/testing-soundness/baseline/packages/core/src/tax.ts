import { defineSchema } from "./schema-factory.js";
import { shared } from "./shared.js";

function setRate(nextRate: number): number {
  shared.factor = nextRate;
  return nextRate;
}

function makePureTag(label: string): string {
  return label;
}

export const callMarker = setRate(2);
export const assignMarker = 2;
export const schema = defineSchema({ currency: "USD" });
export const pureTag = /*#__PURE__*/ makePureTag("v1");

export class TaxPolicy {
  readonly kind = "tax-policy";
  static {
    shared.policyBoost = 0;
  }
}

export function computeTax(amount: number): number {
  return amount * shared.factor + shared.policyBoost + shared.importSideEffect;
}

export function formatTax(amount: number): string {
  return `$${String(amount)}`;
}
