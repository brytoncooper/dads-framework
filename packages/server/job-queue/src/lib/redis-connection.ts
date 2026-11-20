import type { ConnectionOptions } from "bullmq";

/** Parse the exact Redis URL subset the queue supports at its runtime boundary. */
export function redisConnection(redisUrl: string): ConnectionOptions {
  const url = parseRedisUrl(redisUrl);
  validateRedisUrl(url);
  const database = parseDatabaseIndex(url.pathname);
  return {
    host: url.hostname,
    port: Number(url.port || "6379"),
    ...connectionCredentials(url),
    ...databaseOption(database),
    ...tlsOption(url.protocol),
  };
}

function validateRedisUrl(url: URL): void {
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }
  if (!url.hostname) {
    throw new Error("REDIS_URL must include a hostname");
  }
  if (url.search || url.hash) {
    throw new Error("REDIS_URL query parameters and fragments are unsupported");
  }
}

function connectionCredentials(url: URL) {
  return {
    ...(url.username ? { username: decodeCredential(url.username) } : {}),
    ...(url.password ? { password: decodeCredential(url.password) } : {}),
  };
}

function databaseOption(database: number | undefined) {
  return database === undefined ? {} : { db: database };
}

function tlsOption(protocol: string) {
  return protocol === "rediss:" ? { tls: {} } : {};
}

function parseRedisUrl(redisUrl: string): URL {
  try {
    return new URL(redisUrl);
  } catch {
    throw new Error("REDIS_URL must be a valid Redis URL");
  }
}

function parseDatabaseIndex(pathname: string): number | undefined {
  if (pathname === "" || pathname === "/") return undefined;
  if (!/^\/\d+$/.test(pathname)) {
    throw new Error("REDIS_URL path must be a numeric database index");
  }
  return Number(pathname.slice(1));
}

function decodeCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("REDIS_URL contains an invalid escaped credential");
  }
}
