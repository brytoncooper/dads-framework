import type { LeafOptions } from "../../../packages/core/src/types.js";
export const accepts = (options: LeafOptions): LeafOptions => options;
export const accepted = accepts({ tag: "baseline" });
