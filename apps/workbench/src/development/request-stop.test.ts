// A stale control port must never turn into a mutating request to another local service.
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { requestDevelopmentStop } from "./request-stop.js";

it("authenticates the target before sending any shutdown instruction or secret", async () => {
  const observed: {
    method: string | undefined;
    authorization: string | undefined;
  }[] = [];
  const server = createServer((request, response) => {
    observed.push({
      method: request.method,
      authorization: request.headers.authorization,
    });
    response.writeHead(404, { connection: "close" });
    response.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port.");
  try {
    await expect(requestDevelopmentStop({ port: address.port, key: "a".repeat(64) })).rejects.toThrow();
    expect(observed).toEqual([{ method: "GET", authorization: undefined }]);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
