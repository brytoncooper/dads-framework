import { expect, it, vi } from "vitest";

import { ROW_VERSION_CONFLICT } from "@dads-framework/core/contract";

import { ApiError } from "./api-error.js";
import { saveWithRefresh } from "./save-with-refresh.js";

it("refreshes stale state without replaying the write", async () => {
  const save = vi.fn().mockRejectedValue(new ApiError(409, ROW_VERSION_CONFLICT, "Changed"));
  const refresh = vi.fn().mockResolvedValue({ title: "Saved by another editor", rowVersion: 2 });

  await expect(saveWithRefresh({ save, refresh })).resolves.toEqual({
    kind: "stale",
    latest: { title: "Saved by another editor", rowVersion: 2 },
  });
  expect(save).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("returns the result of a successful write without refreshing", async () => {
  const refresh = vi.fn();
  await expect(saveWithRefresh({ save: () => Promise.resolve(2), refresh })).resolves.toEqual({
    kind: "saved",
    value: 2,
  });
  expect(refresh).not.toHaveBeenCalled();
});

it("lets unrelated refusals and failed refreshes reach the normal error path", async () => {
  const refusal = new ApiError(409, "NAME_IN_USE", "In use");
  const refresh = vi.fn().mockRejectedValue(new Error("Refresh failed"));
  await expect(saveWithRefresh({ save: () => Promise.reject(refusal), refresh })).rejects.toBe(refusal);
  expect(refresh).not.toHaveBeenCalled();

  await expect(
    saveWithRefresh({
      save: () => Promise.reject(new ApiError(409, ROW_VERSION_CONFLICT, "Changed")),
      refresh,
    }),
  ).rejects.toThrow("Refresh failed");
});
