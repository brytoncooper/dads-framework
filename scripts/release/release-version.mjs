import { readFileSync } from "node:fs";
import { join } from "node:path";

export function releaseVersion(root) {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
    throw new Error("Expected a release version in the root package.json.");
  }
  return version;
}
