/**
 * What: every shape `pg` dispatches a statement in is counted exactly once.
 * Why: this wrapper sits in front of every query the API issues. Counting the
 * promise form only would silently miss the single-statement path — the one
 * `pool.query` uses, and the one most of this codebase takes — and counting on
 * every checkout would double the numbers for a reused client. Both failures
 * are quiet and both corrupt the column they exist to fill, so each shape gets
 * its own case here rather than a database test that would prove less.
 */

import { describe, expect, it, vi } from "vitest";

import { measureWork } from "@dads-framework/runtime/request-work";

import { countStatementsOn } from "./counting-client.js";

/** What every client below looks like: one forwarding `query`, nothing else. */
type TestClient = { query: (...args: readonly unknown[]) => unknown };

/** A client in the promise shape: `query(text, values?)` resolves a result. */
function resolvingClient(result: unknown = { rows: [] }): TestClient {
  return { query: () => Promise.resolve(result) };
}

function isCallback(
  value: unknown,
): value is (...args: readonly unknown[]) => void {
  return typeof value === "function";
}

/** A client in the callback shape, the one `pool.query` dispatches through. */
function callingBackClient(error?: Error): TestClient {
  return {
    query: (...args: readonly unknown[]): unknown => {
      const callback: unknown = args.at(-1);
      if (!isCallback(callback)) return undefined;
      queueMicrotask(() => {
        callback(error, { rows: [] });
      });
      return { submitted: true };
    },
  };
}

describe("counting statements on a client", () => {
  it("counts a promise-form query and returns its result", async () => {
    const client = resolvingClient({ rows: [1] });
    countStatementsOn(client);

    const { result, tally } = await measureWork(() => client.query("select 1"));

    expect(result).toEqual({ rows: [1] });
    expect(tally.dbQueryCount).toBe(1);
  });

  it("counts a promise-form query that rejected, and rethrows it", async () => {
    const failure = new Error("relation does not exist");
    const client: TestClient = { query: () => Promise.reject(failure) };
    countStatementsOn(client);

    const { tally } = await measureWork(async () => {
      await expect(client.query("select nope")).rejects.toBe(failure);
    });

    expect(tally.dbQueryCount).toBe(1);
  });

  it("counts a callback-form query when pg reports it done", async () => {
    // `pg-pool.query` dispatches as `client.query(text, values, callback)`.
    const client = callingBackClient();
    countStatementsOn(client);
    const callback = vi.fn();

    const { tally } = await measureWork(async () => {
      client.query("select 1", [], callback);
      await new Promise((resolve) => {
        queueMicrotask(() => {
          resolve(undefined);
        });
      });
    });

    expect(callback).toHaveBeenCalledWith(undefined, { rows: [] });
    expect(tally.dbQueryCount).toBe(1);
  });

  it("counts a callback-form query that failed", async () => {
    const failure = new Error("deadlock detected");
    const client = callingBackClient(failure);
    countStatementsOn(client);
    const callback = vi.fn();

    const { tally } = await measureWork(async () => {
      client.query("update ...", [], callback);
      await new Promise((resolve) => {
        queueMicrotask(() => {
          resolve(undefined);
        });
      });
    });

    expect(callback).toHaveBeenCalledWith(failure, { rows: [] });
    expect(tally.dbQueryCount).toBe(1);
  });

  it("counts a submittable as one statement", async () => {
    // A cursor or COPY stream finishes on its own events. One statement.
    const client: TestClient = { query: () => ({ submit: () => undefined }) };
    countStatementsOn(client);

    const { tally } = await measureWork(() => client.query("declare c"));

    expect(tally.dbQueryCount).toBe(1);
  });

  it("instruments a client once however many times it is checked out", async () => {
    // pg returns the same client object to the pool and hands it out again;
    // wrapping the wrapper would count one statement twice, then four times.
    const client = resolvingClient();
    countStatementsOn(client);
    countStatementsOn(client);
    countStatementsOn(client);

    const { tally } = await measureWork(() => client.query("select 1"));

    expect(tally.dbQueryCount).toBe(1);
  });

  it("stays inert outside a request", async () => {
    const client = resolvingClient({ rows: ["job work"] });
    countStatementsOn(client);

    await expect(client.query("select 1")).resolves.toEqual({
      rows: ["job work"],
    });
  });
});
