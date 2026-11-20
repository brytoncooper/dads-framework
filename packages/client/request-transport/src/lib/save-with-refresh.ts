import { ROW_VERSION_CONFLICT } from "@dads-framework/contract";

import { readClientFailure } from "./api-error.js";

export type SaveWithRefreshResult<Saved, Latest> =
  | { readonly kind: "saved"; readonly value: Saved }
  | { readonly kind: "stale"; readonly latest: Latest };

/** Run a save once. Refresh a stale record so the caller can review its draft. */
export async function saveWithRefresh<Saved, Latest>(options: {
  readonly save: () => Promise<Saved>;
  readonly refresh: () => Promise<Latest>;
}): Promise<SaveWithRefreshResult<Saved, Latest>> {
  try {
    return { kind: "saved", value: await options.save() };
  } catch (error) {
    const failure = readClientFailure(error);
    if (
      failure.kind !== "api" ||
      failure.status !== 409 ||
      failure.code !== ROW_VERSION_CONFLICT
    ) {
      throw error;
    }
    return { kind: "stale", latest: await options.refresh() };
  }
}
