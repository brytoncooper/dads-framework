/**
 * Runs one verify step as a child process and keeps everything it wrote.
 *
 * Output is normally buffered: fifteen steps interleaving their
 * lines would be unreadable, and the only output anybody needs in full is the
 * output of the step that failed, which the reporter prints as one block the
 * moment it fails. Hosted verification can stream the exclusive test step.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import process from "node:process";

/** Resolves with `{ exitCode, output }`; it never rejects. */
export function spawnStep(step, cwd) {
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, { cwd, env: process.env });
    const chunks = [];
    const stream =
      step.id === "test" && process.env.DADS_VERIFY_TEST_PROGRESS === "1";
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      if (stream) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      chunks.push(chunk);
      if (stream) process.stderr.write(chunk);
    });
    child.on("error", (error) =>
      resolve({ exitCode: 1, output: `${step.command}: ${error.message}\n` }),
    );
    child.on("close", (code, signal) => resolve(closed(chunks, code, signal)));
  });
}

function closed(chunks, code, signal) {
  return {
    exitCode: code ?? (signal === null ? 1 : 128),
    output: Buffer.concat(chunks).toString("utf8"),
  };
}
