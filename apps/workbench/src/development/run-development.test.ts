// Cancellation must stop waiting for authority, but never abandon a shutdown already sent.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { acquireDevelopmentLease, prepareDevelopmentDirectory } from "./local-state.js";
import { startDevelopmentControl, writeControlRecord } from "./control-server.js";
import { runWorkbenchDevelopment } from "./run-development.js";

function scenario() {
  const root = mkdtempSync(join(tmpdir(), "dads-stop-cancellation-"));
  const directory = prepareDevelopmentDirectory(root, "proof");
  const lease = acquireDevelopmentLease(directory);
  const controller = new AbortController();
  const reason = new Error("Stop request cancelled by its caller.");
  const run = () =>
    runWorkbenchDevelopment({
      root,
      arguments: { action: "stop", instance: "proof", port: 4317 },
      signal: controller.signal,
      requestStop: () => {},
      report: () => {},
    }).then(
      () => ({ outcome: "completed" }),
      (error: unknown) => ({ outcome: "rejected", error }),
    );
  const close = () => {
    lease.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, directory, lease, controller, reason, run, close };
}

describe("development stop cancellation", () => {
  it("preserves the caller's cancellation while polling for the control record", async () => {
    const current = scenario();
    const pending = current.run();
    current.controller.abort(current.reason);
    try {
      expect(await Promise.race([pending, setTimeout(250, { outcome: "still-waiting" })])).toEqual({
        outcome: "rejected",
        error: current.reason,
      });
    } finally {
      current.lease.close();
      await pending;
      current.close();
    }
  });
  it("rejects an already-cancelled stop without waiting for another instance's lease", async () => {
    const current = scenario();
    current.controller.abort(current.reason);
    const pending = current.run();
    try {
      expect(await Promise.race([pending, setTimeout(250, { outcome: "still-waiting" })])).toEqual({
        outcome: "rejected",
        error: current.reason,
      });
    } finally {
      current.lease.close();
      await pending;
      current.close();
    }
  });

  it("cancels a stalled identity handshake without sending a shutdown", async () => {
    const current = scenario();
    const target = createServer(() => {
      current.controller.abort(current.reason);
    });
    await new Promise<void>((resolve) => {
      target.listen(0, "127.0.0.1", resolve);
    });
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("No test port.");
    writeControlRecord(current.directory, {
      port: address.port,
      key: "a".repeat(64),
    });
    const pending = current.run();
    try {
      expect(await Promise.race([pending, setTimeout(250, { outcome: "still-waiting" })])).toEqual({
        outcome: "rejected",
        error: current.reason,
      });
    } finally {
      target.closeAllConnections();
      await new Promise<void>((resolve) => {
        target.close(() => {
          resolve();
        });
      });
      current.lease.close();
      await pending;
      current.close();
    }
  });

  it("continues waiting for the lease after an authenticated shutdown was sent", async () => {
    const current = scenario();
    let stopped: () => void = () => {};
    const stopReceived = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const control = await startDevelopmentControl(() => {
      current.controller.abort(current.reason);
      stopped();
    });
    writeControlRecord(current.directory, control);
    const pending = current.run();
    try {
      await stopReceived;
      expect(await Promise.race([pending, setTimeout(50, { outcome: "still-waiting" })])).toEqual({
        outcome: "still-waiting",
      });
      current.lease.close();
      expect(await pending).toEqual({ outcome: "completed" });
    } finally {
      await control.close();
      current.lease.close();
      await pending;
      current.close();
    }
  });
});
