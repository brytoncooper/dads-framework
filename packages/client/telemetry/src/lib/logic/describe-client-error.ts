/**
 * A thrown value, reduced to something reportable.
 *
 * Pure, and the only place in the client that reads a stack. Two things it is
 * careful about:
 *
 * - **Frames are locations, never a blob.** A stack string is parsed into
 *   `{function, file, line, column}` so the server stores structure it can
 *   group and query, and so nothing accidentally ships a stack containing a
 *   `file://` path or a query string.
 * - **The fingerprint never uses the message.** Grouping has to survive
 *   wording changes, and a message can carry a value that differs every time
 *   ("order 12345 not found"), which would make every occurrence its own
 *   group. Name plus the top frames is stable.
 */

import type { ClientDiagnosticFrame } from "@dads-framework/contract";

/** How many frames identify a fault; deeper ones are framework noise. */
const FINGERPRINT_FRAMES = 3;
const MAX_FRAMES = 50;
const MAX_MESSAGE = 1_000;
const MAX_NAME = 200;

export type DescribedClientError = {
  readonly name: string;
  readonly message: string;
  readonly frames: readonly ClientDiagnosticFrame[];
  readonly fingerprint: string;
};

export function describeClientError(error: unknown): DescribedClientError {
  const name = errorName(error);
  const message = errorMessage(error);
  const frames = parseFrames(error);
  return {
    name,
    message,
    frames,
    fingerprint: fingerprintOf(name, frames),
  };
}

function errorName(error: unknown): string {
  if (error instanceof Error) return clamp(error.name, MAX_NAME);
  return typeof error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return clamp(error.message, MAX_MESSAGE);
  if (typeof error === "string") return clamp(error, MAX_MESSAGE);
  // A thrown non-Error carries no message worth guessing at, and stringifying
  // an arbitrary object is how user data ends up in a telemetry field.
  return "";
}

/**
 * A stack, as frames.
 *
 * Deliberately forgiving: stack formats differ by engine and none of them are
 * a contract. A line that does not parse is skipped rather than failing the
 * report — a fault with three frames is worth far more than no fault at all.
 */
function parseFrames(error: unknown): readonly ClientDiagnosticFrame[] {
  if (!(error instanceof Error) || typeof error.stack !== "string") return [];
  const frames: ClientDiagnosticFrame[] = [];
  for (const line of error.stack.split("\n").slice(1)) {
    const frame = parseFrame(line.trim());
    if (frame !== undefined) frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

/** `at fn (url:line:col)` and the bare `at url:line:col` both appear. */
const FRAME_WITH_FUNCTION = /^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/;
const FRAME_WITHOUT_FUNCTION = /^at\s+(.+?):(\d+):(\d+)$/;

function parseFrame(line: string): ClientDiagnosticFrame | undefined {
  const named = FRAME_WITH_FUNCTION.exec(line);
  if (named !== null) {
    return {
      function: clamp(named[1] ?? "", MAX_NAME),
      file: fileOf(named[2] ?? ""),
      line: Number(named[3]),
      column: Number(named[4]),
    };
  }
  const anonymous = FRAME_WITHOUT_FUNCTION.exec(line);
  if (anonymous !== null) {
    return {
      file: fileOf(anonymous[1] ?? ""),
      line: Number(anonymous[2]),
      column: Number(anonymous[3]),
    };
  }
  return undefined;
}

/**
 * The path part of a frame's url.
 *
 * A bundle url can carry a query string, and a query string can carry
 * whatever a router put there. The asset path is what symbolication needs;
 * the rest is not ours to ship.
 */
function fileOf(location: string): string {
  const withoutQuery = location.split("?")[0] ?? location;
  return clamp(withoutQuery, 500);
}

/**
 * A stable group key: the error's name and where it came from.
 *
 * A small non-cryptographic hash, because this identifies a group and
 * guards nothing. It has to be identical for the same fault across reloads
 * and across clients, which rules out anything seeded per session.
 */
function fingerprintOf(
  name: string,
  frames: readonly ClientDiagnosticFrame[],
): string {
  const signature = [
    name,
    ...frames
      .slice(0, FINGERPRINT_FRAMES)
      .map(
        (frame) =>
          `${frame.function ?? ""}@${frame.file ?? ""}:${frame.line ?? 0}`,
      ),
  ].join("|");
  let hash = 2_166_136_261;
  for (let at = 0; at < signature.length; at += 1) {
    hash ^= signature.charCodeAt(at);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clamp(value: string, maximum: number): string {
  return value.length > maximum ? value.slice(0, maximum) : value;
}
