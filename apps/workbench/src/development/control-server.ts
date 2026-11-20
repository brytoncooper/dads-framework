import { randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { readPrivateJson } from "./local-state.js";
import {
  controlProtocol,
  matchesProof,
  serverProof,
  stopProof,
} from "./control-proof.js";

const controlRecord = z.strictObject({
  port: z.number().int().min(1).max(65_535),
  key: z.string().regex(/^[a-f0-9]{64}$/u),
});

/** The client's single-use challenge, or undefined when it is missing or malformed. */
function readChallengeNonce(request: IncomingMessage): string | undefined {
  const nonce = request.headers["x-dads-challenge"];
  return typeof nonce === "string" && /^[a-f0-9]{64}$/.test(nonce)
    ? nonce
    : undefined;
}

/** The exact loopback authority this server answers to, once it is listening. */
function expectedControlHost(server: Server): string | undefined {
  const address = server.address();
  return address && typeof address !== "string"
    ? `127.0.0.1:${String(address.port)}`
    : undefined;
}

/** A control upgrade is a bodiless loopback GET for this protocol alone, with no browser origin. */
function isControlUpgrade(
  request: IncomingMessage,
  head: Buffer,
  expectedHost: string | undefined,
): boolean {
  return (
    request.method === "GET" &&
    request.url === "/control" &&
    request.headers.upgrade === controlProtocol &&
    request.headers.host === expectedHost &&
    request.headers.origin === undefined &&
    head.length === 0 &&
    request.headers["transfer-encoding"] === undefined &&
    (request.headers["content-length"] === undefined ||
      request.headers["content-length"] === "0")
  );
}

/** An instance-local shutdown channel, separate from the workbench API and identities. */
export async function startDevelopmentControl(onStop: () => void) {
  const key = randomBytes(32).toString("hex");
  let stopped = false;
  const sockets = new Set<Duplex>();
  const server = createServer((_request, response) => {
    response.writeHead(404, { connection: "close" });
    response.end();
  });
  server.maxConnections = 16;
  server.on("upgrade", (request, socket, head) => {
    const nonce = readChallengeNonce(request);
    if (
      nonce === undefined ||
      sockets.size >= 8 ||
      !isControlUpgrade(request, head, expectedControlHost(server))
    ) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const timer = setTimeout(() => {
      socket.destroy();
    }, 2000);
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
    socket.on("error", () => {
      socket.destroy();
    });
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${controlProtocol}\r\nX-Dads-Proof: ${serverProof(key, nonce)}\r\n\r\n`,
    );
    let frame = "";
    socket.on("data", (chunk: Buffer) => {
      frame += chunk.toString("utf8");
      if (
        frame.length > 70 ||
        (frame.includes("\n") && !/^STOP [a-f0-9]{64}\n$/.test(frame))
      ) {
        socket.destroy();
        return;
      }
      if (!frame.endsWith("\n")) return;
      if (!matchesProof(frame.slice(5, -1), stopProof(key, nonce))) {
        socket.destroy();
        return;
      }
      socket.removeAllListeners("data");
      socket.end("STOPPED\n");
      if (!stopped) {
        stopped = true;
        onStop();
      }
    });
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 2000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Control port unavailable.");
  return {
    port: address.port,
    key,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      }),
  };
}

export function writeControlRecord(
  directory: string,
  value: { port: number; key: string },
): void {
  const validated = controlRecord.parse({ port: value.port, key: value.key });
  const temporary = join(
    directory,
    `control-${randomBytes(8).toString("hex")}.tmp`,
  );
  writeFileSync(temporary, JSON.stringify(validated), {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, join(directory, "control.json"));
}

export function readControlRecord(directory: string) {
  return readPrivateJson(join(directory, "control.json"), (value) =>
    controlRecord.parse(value),
  );
}
