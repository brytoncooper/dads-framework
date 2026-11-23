/**
 * Redis URLs are an external deployment boundary: credentials, TLS, and the
 * database index must be interpreted explicitly rather than silently dropped.
 */
import { describe, expect, it } from "vitest";
import { redisConnection } from "./redis-connection.js";

describe("redisConnection", () => {
  it("parses escaped credentials and a database index", () => {
    expect(redisConnection("redis://job%40user:p%2Fass@redis.example.test:6380/3")).toEqual({
      host: "redis.example.test",
      port: 6380,
      username: "job@user",
      password: "p/ass",
      db: 3,
    });
  });

  it("enables TLS for rediss", () => {
    expect(redisConnection("rediss://redis.example.test:6379")).toMatchObject({
      host: "redis.example.test",
      port: 6379,
      tls: {},
    });
  });

  it.each([
    "http://redis.example.test:6379",
    "redis://redis.example.test/not-a-database",
    "redis://redis.example.test/0?family=6",
  ])("rejects unsupported Redis URL input %s", (url) => {
    expect(() => redisConnection(url)).toThrow(/REDIS_URL/);
  });
});
