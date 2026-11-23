/** Build the checkout's native test engine for the current Rust host. */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { requireFile } from "./verify-testing-package-lib.mjs";

export function buildTestingHostBinary(root) {
  const metadata = execFileSync("rustc", ["-vV"], {
    cwd: root,
    encoding: "utf8",
  });
  const host = /^host: ([a-z0-9_]+(?:-[a-z0-9_]+)+)$/mu.exec(metadata)?.[1];
  if (host === undefined) throw new Error("rustc did not report a host target.");

  const targetDirectory = join(root, "target");
  execFileSync(
    "cargo",
    ["build", "--locked", "--package", "dad-test", "--target", host, "--target-dir", targetDirectory],
    { cwd: root, stdio: "inherit" },
  );
  const binary = join(targetDirectory, host, "debug", process.platform === "win32" ? "dad-test.exe" : "dad-test");
  requireFile(binary, "Cargo-built host testing executable");
  return binary;
}
