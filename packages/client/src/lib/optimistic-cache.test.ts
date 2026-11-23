/**
 * What: a write is shown on every cached read that holds its record before
 * the server answers, and put back exactly when the server refuses.
 * Why: a screen that waits on the network for every click feels slow, and one
 * that guesses without undoing a refusal lies.
 */
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { applyRecordEffect, optimisticRecordWrite, optimisticRecordWriteWithoutInput } from "./optimistic-cache.js";

const PAGE = {
  items: [
    { id: "a", name: "Corn", status: "ACTIVE" },
    { id: "b", name: "Wheat", status: "ACTIVE" },
  ],
  meta: { total: 2, page: 1, perPage: 25 },
};

describe("applyRecordEffect", () => {
  it("merges a change into the matching row of a page", () => {
    expect(applyRecordEffect(PAGE, { id: "b", change: { status: "ARCHIVED" } })).toEqual({
      ...PAGE,
      items: [PAGE.items[0], { id: "b", name: "Wheat", status: "ARCHIVED" }],
    });
  });

  it("removes a row from a page and lowers its total", () => {
    expect(applyRecordEffect(PAGE, { id: "a", remove: true })).toEqual({
      items: [PAGE.items[1]],
      meta: { total: 1, page: 1, perPage: 25 },
    });
  });

  it("changes a detail read and a plain list", () => {
    expect(applyRecordEffect({ id: "a", name: "Corn" }, { id: "a", change: { name: "Yellow Corn" } })).toEqual({
      id: "a",
      name: "Yellow Corn",
    });
    expect(applyRecordEffect([{ id: "a" }, { id: "b" }], { id: "b", remove: true })).toEqual([{ id: "a" }]);
  });

  it("matches a record by a named key and reaches rows nested in a detail", () => {
    expect(
      applyRecordEffect([{ staffId: "s1", superAdmin: false }], {
        id: "s1",
        key: "staffId",
        change: { superAdmin: true },
      }),
    ).toEqual([{ staffId: "s1", superAdmin: true }]);
    expect(
      applyRecordEffect({ id: "ticket", parties: [{ id: "p1" }, { id: "p2" }] }, { id: "p1", remove: true }),
    ).toEqual({ id: "ticket", parties: [{ id: "p2" }] });
    expect(
      applyRecordEffect(
        { company: { id: "c" }, relationship: { id: "r", roles: [] } },
        { id: "r", change: { roles: ["CUSTOMER"] } },
      ),
    ).toEqual({
      company: { id: "c" },
      relationship: { id: "r", roles: ["CUSTOMER"] },
    });
  });

  it("returns reads that do not hold the record untouched", () => {
    const detail = { id: "c", name: "Oats" };
    expect(applyRecordEffect(PAGE, { id: "z", remove: true })).toBe(PAGE);
    expect(applyRecordEffect(detail, { id: "a", change: { name: "x" } })).toBe(detail);
    expect(applyRecordEffect(undefined, { id: "a", remove: true })).toBe(undefined);
  });
});

describe("optimisticRecordWrite", () => {
  it("shows the write at once and restores every read when refused", async () => {
    const queryClient = new QueryClient();
    const listKey = ["products", "ctx", "list", { page: 1 }];
    const detailKey = ["products", "ctx", "detail", "a"];
    queryClient.setQueryData(listKey, PAGE);
    queryClient.setQueryData(detailKey, PAGE.items[0]);
    const write = optimisticRecordWrite<string>(queryClient, ["products", "ctx"], (id) => ({
      id,
      change: { status: "ARCHIVED" },
    }));

    const snapshot = await write.onMutate("a");
    expect(queryClient.getQueryData(detailKey)).toEqual({
      id: "a",
      name: "Corn",
      status: "ARCHIVED",
    });

    write.onError(new Error("refused"), "a", snapshot);
    expect(queryClient.getQueryData(listKey)).toEqual(PAGE);
    expect(queryClient.getQueryData(detailKey)).toEqual(PAGE.items[0]);
  });

  it("restores a write that takes no input when it is refused", async () => {
    const queryClient = new QueryClient();
    const listKey = ["products", "ctx", "list"];
    queryClient.setQueryData(listKey, PAGE);
    const write = optimisticRecordWriteWithoutInput(queryClient, ["products", "ctx"], { id: "a", remove: true });
    await write.onMutate();
    expect(queryClient.getQueryData(listKey)).toEqual({
      items: [PAGE.items[1]],
      meta: { total: 1, page: 1, perPage: 25 },
    });
    write.onError(new Error("refused"));
    expect(queryClient.getQueryData(listKey)).toEqual(PAGE);
  });

  it("leaves the cache alone when the write has no visible effect", async () => {
    const queryClient = new QueryClient();
    const listKey = ["products", "ctx", "list"];
    queryClient.setQueryData(listKey, PAGE);
    const write = optimisticRecordWrite<string>(queryClient, ["products", "ctx"], () => null);
    expect(await write.onMutate("a")).toEqual({ entries: [] });
    expect(queryClient.getQueryData(listKey)).toBe(PAGE);
  });
});
