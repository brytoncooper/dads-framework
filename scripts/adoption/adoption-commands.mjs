/**
 * Child processes for the adoption proofs, captured rather than streamed.
 *
 * Concurrent proofs cannot share a terminal: interleaved output is unreadable
 * and its order changes run to run. Every command therefore writes into the
 * transcript of the task that ran it, and the runner prints those transcripts
 * afterwards in a fixed order. A failing command carries its own full output —
 * the command line, the working directory, the exit status, stdout and stderr —
 * so nothing is lost by not having watched it happen.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

export class AdoptionCommandError extends Error {
  constructor(entry) {
    super(`${describeCommand(entry)} exited with ${describeExit(entry)}.`);
    this.name = "AdoptionCommandError";
    this.entry = entry;
  }
}

export function createTaskTranscript(name) {
  const entries = [];
  const transcript = {
    name,
    entries,
    async attempt(command, argumentList, options = {}) {
      const entry = await execute(command, argumentList, options);
      entries.push(entry);
      return entry;
    },
    async run(command, argumentList, options = {}) {
      const entry = await transcript.attempt(command, argumentList, options);
      if (entry.status !== 0) throw new AdoptionCommandError(entry);
      return entry;
    },
    note(message) {
      entries.push({ note: message });
    },
  };
  return transcript;
}

export function formatTranscript(transcript) {
  const lines = [];
  for (const entry of transcript.entries) {
    if (entry.note !== undefined) {
      lines.push(`# ${entry.note}`);
      continue;
    }
    lines.push(`$ ${describeCommand(entry)}`, ...indent(entry.stdout), ...indent(entry.stderr));
  }
  return lines.join("\n");
}

/**
 * The whole story of a failed task: every command it ran with the output that
 * command produced, then what actually went wrong. The transcript is what makes
 * a concurrent failure readable — nothing was printed while it happened, so
 * this is the only account of it.
 */
export function formatFailure(name, error, transcript) {
  const lines = [`FAILED ${name}`];
  if (transcript && transcript.entries.length > 0) {
    lines.push("  transcript:", ...indent(formatTranscript(transcript), "    "));
  }
  if (error instanceof AdoptionCommandError) {
    lines.push(`  command: ${describeCommand(error.entry)}`, `  exit: ${describeExit(error.entry)}`);
    return lines.join("\n");
  }
  return [...lines, "  error:", ...indent(stackOf(error), "    ")].join("\n");
}

function execute(command, argumentList, options) {
  if (typeof command !== "string" || !Array.isArray(argumentList)) {
    throw new Error("A command needs an executable string and an argument array.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentList, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({
        command,
        argumentList,
        cwd: options.cwd ?? null,
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function describeCommand(entry) {
  const line = [entry.command, ...entry.argumentList].join(" ");
  return entry.cwd === null ? line : `${line}  (in ${entry.cwd})`;
}

function describeExit(entry) {
  return entry.signal === null || entry.signal === undefined ? `status ${entry.status}` : `signal ${entry.signal}`;
}

function indent(text, prefix = "  ") {
  if (typeof text !== "string" || text.length === 0) return [];
  return text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `${prefix}${line}`);
}

function stackOf(error) {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
