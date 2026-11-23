/** Proves `dad` exits quietly on stdout `EPIPE` while rethrowing other stream errors. */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { installBrokenPipeHandler, isBrokenPipeError } from "./cli-io.js";

const dadExecutable = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "dad.js");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createErrorWithCode(message: string, code: string): Error {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

function createLargeDoctorFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "dad-cli-epipe-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "packages", "demo"), { recursive: true });
  mkdirSync(join(root, "node_modules", ".dads"), { recursive: true });
  writeFileSync(join(root, "packages", "demo", "package.json"), JSON.stringify({ name: "@fixture/demo" }));
  const testResults = Array.from({ length: 4000 }, (_, index) => ({
    name: `${root}/packages/demo/src/suite-${index}.test.ts`,
    assertionResults: [{ status: "passed" }],
  }));
  writeFileSync(join(root, "node_modules", ".dads", "vitest-report.json"), JSON.stringify({ testResults }));
  return root;
}

describe("CLI stdout EPIPE handling", () => {
  it("recognizes EPIPE errors and calls the broken-pipe callback quietly", () => {
    const stream = new EventEmitter();
    let handled = 0;
    installBrokenPipeHandler(stream, () => {
      handled += 1;
    });

    const epipe = createErrorWithCode("write EPIPE", "EPIPE");
    expect(isBrokenPipeError(epipe)).toBe(true);
    expect(() => stream.emit("error", epipe)).not.toThrow();
    expect(handled).toBe(1);
  });

  it("rethrows non-EPIPE stdout errors instead of hiding them", () => {
    const stream = new EventEmitter();
    let handled = 0;
    installBrokenPipeHandler(stream, () => {
      handled += 1;
    });

    const ioError = createErrorWithCode("write EIO", "EIO");
    expect(isBrokenPipeError(ioError)).toBe(false);
    expect(() => stream.emit("error", ioError)).toThrow("write EIO");
    expect(handled).toBe(0);
  });

  it("exits cleanly without an EPIPE stack trace when piped to a consumer that closes early", async () => {
    const fixtureRoot = createLargeDoctorFixture();
    const result = await runDadWithEarlyClose(fixtureRoot, [
      "doctor",
      fixtureRoot,
      "--issue",
      "commitment-issues",
      "--json",
    ]);

    expect(result.receivedOutput).toBe(true);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });
});

type EarlyCloseResult = {
  readonly code: number | null;
  readonly stderr: string;
  readonly receivedOutput: boolean;
};

function runDadWithEarlyClose(cwd: string, commandArguments: readonly string[]): Promise<EarlyCloseResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dadExecutable, ...commandArguments], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let receivedOutput = false;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.once("data", () => {
      receivedOutput = true;
      child.stdout.destroy();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr, receivedOutput });
    });
  });
}
