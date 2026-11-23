import type { DadTestCliIo } from "./dad-test-cli.js";

/**
 * Every successful command writes the same two shapes: one versioned JSON
 * envelope for machines, and a human line plus indented JSON for people. The
 * envelope is the contract; the human form is explicitly not.
 */
export function writeCommandSuccess(io: DadTestCliIo, json: boolean, operation: string, result: unknown): void {
  io.stdout(
    json
      ? `${JSON.stringify({ schemaVersion: 1, ok: true, result })}\n`
      : `${operation} completed. Use --json for the versioned machine-readable result.\n${JSON.stringify(result, null, 2)}\n`,
  );
}
