// Reflection and half-open sessions must not become shutdown capabilities or unbounded sockets.
import { request } from "node:http";
import type { Duplex } from "node:stream";
import { expect, it } from "vitest";
import { startDevelopmentControl } from "./control-server.js";
import { controlProtocol } from "./control-proof.js";
import { requestDevelopmentStop } from "./request-stop.js";

it("rejects reflected server proofs and wrong client keys", async () => {
  let stops = 0;
  const control = await startDevelopmentControl(() => {
    stops += 1;
  });
  try {
    await expect(
      requestDevelopmentStop({ port: control.port, key: "a".repeat(64) }),
    ).rejects.toThrow();
    const session = await openSession(control.port);
    const closed = new Promise<void>((resolve) => {
      session.socket.once("close", () => {
        resolve();
      });
    });
    session.socket.write(`STOP ${String(session.proof)}\n`);
    session.socket.resume();
    await closed;
    expect(stops).toBe(0);
  } finally {
    await control.close();
  }
});

it("closes incomplete sessions within a bounded wait", async () => {
  let stops = 0;
  const control = await startDevelopmentControl(() => {
    stops += 1;
  });
  try {
    const session = await openSession(control.port);
    session.socket.resume();
    await new Promise<void>((resolve) => {
      session.socket.once("close", () => {
        resolve();
      });
    });
    expect(stops).toBe(0);
  } finally {
    await control.close();
  }
}, 4000);

function openSession(port: number) {
  return new Promise<{
    socket: Duplex;
    proof: string | string[] | undefined;
  }>((resolve, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1",
      port,
      path: "/control",
      method: "GET",
      agent: false,
      headers: {
        connection: "Upgrade",
        upgrade: controlProtocol,
        "x-dads-challenge": "a".repeat(64),
      },
    });
    outgoing.once("error", reject);
    outgoing.once("upgrade", (response, socket) => {
      resolve({ socket, proof: response.headers["x-dads-proof"] });
    });
    outgoing.end();
  });
}
