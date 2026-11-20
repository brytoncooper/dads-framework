import { randomBytes } from "node:crypto";
import { request } from "node:http";
import type { Duplex } from "node:stream";
import {
  controlProtocol,
  matchesProof,
  serverProof,
  stopProof,
} from "./control-proof.js";

/** Verify the server, then send one authenticated frame on that exact connection. Never reconnect. */
export function requestDevelopmentStop(
  control: { port: number; key: string },
  signal?: AbortSignal,
): Promise<void> {
  const nonce = randomBytes(32).toString("hex");
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let socket: Duplex | undefined;
    let settled = false;
    const outgoing = request({
      hostname: "127.0.0.1",
      port: control.port,
      path: "/control",
      method: "GET",
      agent: false,
      headers: {
        connection: "Upgrade",
        upgrade: controlProtocol,
        "x-dads-challenge": nonce,
      },
    });
    const timer = setTimeout(() => {
      finish(false);
    }, 3000);
    const cancel = () => {
      finish(false, signal?.reason);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    function finish(success: boolean, reason?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      socket?.destroy();
      outgoing.destroy();
      if (success) resolve();
      else
        reject(
          reason instanceof Error
            ? reason
            : new Error(
                "Workbench control identity or shutdown acknowledgement could not be verified.",
              ),
        );
    }
    outgoing.once("error", () => {
      finish(false);
    });
    outgoing.once("response", (response) => {
      response.destroy();
      finish(false);
    });
    outgoing.once("upgrade", (response, upgraded, head) => {
      socket = upgraded;
      if (
        response.statusCode !== 101 ||
        response.headers.upgrade !== controlProtocol ||
        head.length !== 0 ||
        !matchesProof(
          response.headers["x-dads-proof"],
          serverProof(control.key, nonce),
        )
      ) {
        finish(false);
        return;
      }
      let received = "";
      upgraded.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (received === "STOPPED\n") finish(true);
        else if (received.length >= 8) finish(false);
      });
      upgraded.once("error", () => {
        finish(false);
      });
      upgraded.once("close", () => {
        if (!settled) finish(false);
      });
      // After sending STOP, cancellation cannot unsend it. Await its bounded
      // acknowledgement; the caller then waits for the instance's cleanup.
      signal?.removeEventListener("abort", cancel);
      upgraded.write(`STOP ${stopProof(control.key, nonce)}\n`);
    });
    outgoing.end();
  });
}
