import { expect, it, vi } from "vitest";
import { RevisionedLookup } from "./revisioned-lookup.js";
import type { PostgresQuery, PostgresRow } from "./postgres-types.js";

it("revalidates a pending result before a late caller can use it", async () => {
  let finish: (rows: readonly PostgresRow[]) => void = () => {
    throw new Error("Missing fixture resolver");
  };
  const pending = new Promise<readonly PostgresRow[]>((resolve) => {
    finish = resolve;
  });
  const read = vi
    .fn<(query: PostgresQuery) => Promise<readonly PostgresRow[]>>()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce([{ stamp: "revoked" }])
    .mockResolvedValueOnce([{ stamp: "revoked", resource_ids: "[]" }])
    .mockResolvedValueOnce([{ stamp: "revoked" }]);
  const lookup = new RevisionedLookup("first", read);
  const question = {
    resourceType: "note",
    permission: "view",
    subject: { type: "user", id: "actor" },
  };
  const compile = () => ({ text: "SELECT resource_id" });
  const early = lookup.lookup(question, compile);
  const late = lookup.lookup(question, compile);
  finish([{ stamp: "granted", resource_ids: '["previous"]' }]);

  await expect(early).resolves.toEqual(["previous"]);
  const revoked = await late;
  expect(revoked).toEqual([]);
  expect(await lookup.lookup(question, compile)).toBe(revoked);
  expect(read).toHaveBeenCalledTimes(4);
});
