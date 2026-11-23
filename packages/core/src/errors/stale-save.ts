import { ROW_VERSION_CONFLICT } from "../contract/index.js";

import { conflict } from "./domain-error.js";

/** An authorized save's expected revision no longer matches. */
export function staleSave() {
  return conflict(
    ROW_VERSION_CONFLICT,
    "The record has changed since it was loaded.",
  );
}
