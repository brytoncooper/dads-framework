/**
 * What: a token is kept only from a write that overlapped no other write;
 * overlapping, failed or schema writes leave no trusted token.
 * Why: the adapter runs writes one at a time, so overlap should never happen
 * there. This is the safety net if it ever does: sending an older token than
 * the newest write would let a check read past a committed revocation.
 */

import { describe, expect, it } from "vitest";

import { NewestWrittenToken } from "./newest-written-token.js";

function deferred() {
  let resolve: (token: string) => void = () => undefined;
  const promise = new Promise<string>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const asToken = (token: string): string => token;

describe("NewestWrittenToken", () => {
  it("holds nothing before any write", () => {
    expect(new NewestWrittenToken().current()).toBeUndefined();
  });

  it("never replaces a newer token with one from a write that overlapped it", async () => {
    const newest = new NewestWrittenToken();
    const first = deferred();
    const second = deferred();
    const firstWrite = newest.track(() => first.promise, asToken);
    const secondWrite = newest.track(() => second.promise, asToken);
    // The second finishes first; the first's token may be older or newer.
    second.resolve("second");
    await secondWrite;
    expect(newest.current()).toBe("second");
    first.resolve("first");
    await firstWrite;
    expect(newest.current()).toBeUndefined();

    await newest.track(() => Promise.resolve("third"), asToken);
    expect(newest.current()).toBe("third");
  });

  it("holds nothing after a failed write or a schema write", async () => {
    const newest = new NewestWrittenToken();
    await newest.track(() => Promise.resolve("written"), asToken);
    await expect(newest.track(() => Promise.reject(new Error("deadline")), asToken)).rejects.toThrow("deadline");
    expect(newest.current()).toBeUndefined();

    await newest.track(() => Promise.resolve("again"), asToken);
    newest.forget();
    expect(newest.current()).toBeUndefined();
  });
});
