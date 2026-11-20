import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Test support for the native protocol seam. The fake binary speaks the same
 * one-request/one-response protocol as the Rust engine: it reads the whole
 * request from stdin, records it, and prints one canned response. Tests use it
 * to assert what the facade sent and how it reads what the engine returned,
 * without building the engine.
 */

export type FakeNativeBinary = {
  /** Path to the executable to pass as `nativeBinary` or `DADS_TEST_NATIVE_BINARY`. */
  readonly binary: string;
  /** Parses the request the facade sent on stdin. */
  readonly readRequest: () => unknown;
};

export function createFakeNativeBinary(
  directory: string,
  response: unknown,
  options: { readonly exitCode?: number } = {},
): FakeNativeBinary {
  const binary = join(directory, "fake-native-binary.mjs");
  const requestPath = join(directory, "request.json");
  const exitCode = options.exitCode ?? 0;
  const source = [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    'let request = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => {',
    "  request += chunk;",
    "});",
    'process.stdin.on("end", () => {',
    `  writeFileSync(${JSON.stringify(requestPath)}, request, "utf8");`,
    `  process.stdout.write(${JSON.stringify(`${JSON.stringify(response)}\n`)});`,
    `  process.exitCode = ${String(exitCode)};`,
    "});",
    "",
  ].join("\n");
  writeFileSync(binary, source, "utf8");
  chmodSync(binary, 0o755);
  return {
    binary,
    readRequest: (): unknown => JSON.parse(readFileSync(requestPath, "utf8")),
  };
}
