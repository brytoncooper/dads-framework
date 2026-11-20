import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMissingPathError } from "./missing-path-error.js";

const receiptPath = ".dads/dependency-installation.sha256";

export function dependenciesAreInstalled(projectRoot: string): boolean {
  if (!existsSync(join(projectRoot, "node_modules"))) return false;
  try {
    return (
      readFileSync(join(projectRoot, receiptPath), "utf8").trim() ===
      hashInstallationInputs(projectRoot)
    );
  } catch (error: unknown) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

export function recordDadsDependencyInstallation(projectRoot: string): void {
  const absoluteReceiptPath = join(projectRoot, receiptPath);
  mkdirSync(dirname(absoluteReceiptPath), { recursive: true });
  writeFileSync(
    absoluteReceiptPath,
    `${hashInstallationInputs(projectRoot)}\n`,
  );
}

function hashInstallationInputs(projectRoot: string): string {
  return createHash("sha256")
    .update(process.platform)
    .update("/")
    .update(process.arch)
    .update("/")
    .update(process.versions.modules)
    .update("\0")
    .update(readFileSync(join(projectRoot, "package.json")))
    .update("\0")
    .update(readFileSync(join(projectRoot, "package-lock.json")))
    .digest("hex");
}
