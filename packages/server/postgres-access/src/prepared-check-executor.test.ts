import { expect, it } from "vitest";
import type { PostgresQuery } from "./postgres-types.js";
import { preparePostgresChecks } from "./prepared-check-executor.js";

it("prepares stable single-check shapes within a fixed budget", async () => {
  const calls: (PostgresQuery & { readonly name?: string })[] = [];
  const pool = {
    query(query: (typeof calls)[number]) {
      calls.push(query);
      return Promise.resolve({ rows: [{ allowed: false }], rowCount: 1 });
    },
  };
  const executor = preparePostgresChecks(pool);
  expect(preparePostgresChecks(pool)).toBe(executor);

  const check = executor.queryCheck?.bind(executor);
  if (check === undefined) throw new Error("Expected a prepared check executor");
  const text = "SELECT $1::text";
  const first = { text, values: ["first"], query_timeout: 100 };
  const second = { text, values: ["second"], query_timeout: 100 };
  await check(first);
  await check(second);
  await executor.query(first);
  const oversized = { text: `SELECT $1::text /* ${"é".repeat(2_100)} */` };
  await check(oversized);

  const name = calls[0]?.name;
  expect(name).toMatch(/^dad_check_[a-f0-9]{40}$/);
  expect(calls.slice(0, 4)).toEqual([{ ...first, name }, { ...second, name }, first, oversized]);

  for (let index = 0; index < 63; index += 1) {
    await check({ text: `SELECT $1::text /* ${String(index)} */` });
  }
  const extra = { text: "SELECT $1::integer" };
  await check(extra);
  await check(first);
  expect(new Set(calls.map((call) => call.name).filter(Boolean)).size).toBe(64);
  expect(calls.at(-2)).toEqual(extra);
  expect(calls.at(-1)?.name).toBe(name);
});

it("bounds the total SQL bytes admitted by one pool", async () => {
  const names: (string | undefined)[] = [];
  const executor = preparePostgresChecks({
    query(query) {
      names.push(query.name);
      return Promise.resolve({ rows: [{ allowed: false }], rowCount: 1 });
    },
  });
  const check = executor.queryCheck?.bind(executor);
  if (check === undefined) throw new Error("Expected named checks");
  for (let index = 0; index < 9; index += 1) {
    await check({
      text: `SELECT $1::text /* ${String(index)} ${"x".repeat(4_000)} */`,
    });
  }
  expect(names.slice(0, 8).every((name) => name !== undefined)).toBe(true);
  expect(names.at(-1)).toBeUndefined();
});
