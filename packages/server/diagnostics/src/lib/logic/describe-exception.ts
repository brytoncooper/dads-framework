/**
 * A thrown value, reduced to what is safe to store and useful to group by.
 *
 * Pure, and the only place on the server that reads a stack — so the only
 * place that could leak one into somewhere it does not belong. Three
 * decisions live here:
 *
 * - **The fingerprint never uses the message.** Grouping has to survive
 *   rewording, and a message can carry a value that differs every time
 *   ("order 12345 not found"), which would make every occurrence its own
 *   group and the whole exercise pointless.
 * - **Only APPLICATION frames shape the fingerprint.** A fault's identity is
 *   where the application went wrong; the dependency and Node-internal frames
 *   underneath it are the same for a hundred different faults.
 *
 *   "Application" is defined by exclusion, deliberately: a frame is one unless
 *   it is `node_modules` or a `node:` internal. A positive in-repository test
 *   would need a root path to compare against, and the production bundle has
 *   none to give — `main.cjs` is one file and every frame in it points at the
 *   bundle. Excluding what is provably not ours is the test that behaves the
 *   same in development and in the image.
 * - **The message is carried but never becomes a column.** It goes in the log
 *   line beside the stack, keyed by request id. `request_log` gets the type
 *   and the fingerprint, because a message can quote whatever a user typed
 *   and that table is bounded only by retention.
 */

/** How many in-repo frames identify a fault; deeper ones are its context. */
const FINGERPRINT_FRAMES = 3;
const MAX_MESSAGE = 2_000;
const MAX_TYPE = 200;

export type DescribedException = {
  /** The exception's class — `TypeError`, `DomainError`, `ZodError`. */
  readonly type: string;
  readonly message: string;
  /** Stable across occurrences of the same fault; safe to `GROUP BY`. */
  readonly fingerprint: string;
  /** The stack as it was, for the log line. Never stored in a column. */
  readonly stack: string | undefined;
};

export function describeException(error: unknown): DescribedException {
  const type = exceptionType(error);
  const stack = error instanceof Error ? error.stack : undefined;
  return {
    type,
    message: exceptionMessage(error),
    fingerprint: fingerprintOf(type, stack),
    stack,
  };
}

function exceptionType(error: unknown): string {
  if (error instanceof Error) return clamp(error.name, MAX_TYPE);
  return typeof error;
}

function exceptionMessage(error: unknown): string {
  if (error instanceof Error) return clamp(error.message, MAX_MESSAGE);
  if (typeof error === "string") return clamp(error, MAX_MESSAGE);
  // Stringifying an arbitrary thrown object is how a payload ends up in a log
  // line. A non-Error carries no message worth guessing at.
  return "";
}

/**
 * Application frames, in order.
 *
 * A frame counts unless it is provably not ours — a dependency or a Node
 * internal. Those are the machinery a fault passed through rather than the
 * place it came from, and they are identical across unrelated faults.
 */
function applicationFrames(stack: string | undefined): readonly string[] {
  if (stack === undefined) return [];
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;
    if (trimmed.includes("node_modules") || trimmed.includes("node:")) continue;
    frames.push(withoutColumn(trimmed));
    if (frames.length >= FINGERPRINT_FRAMES) break;
  }
  return frames;
}

/**
 * The frame without its column number.
 *
 * A column moves when a line is reformatted and the fault has not changed;
 * keeping it would split one group into two after a prettier run.
 */
function withoutColumn(frame: string): string {
  return frame.replace(/:(\d+):(\d+)\)?$/, ":$1");
}

/**
 * A stable group key. A small non-cryptographic hash: it identifies a group
 * and guards nothing, and it must be identical for the same fault across
 * processes, which rules out anything seeded per run.
 */
function fingerprintOf(type: string, stack: string | undefined): string {
  const signature = [type, ...applicationFrames(stack)].join("|");
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
