import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const receipt = "node_modules/.dads-lock";
const lock = createHash("sha256")
  .update(readFileSync("package.json"))
  .update(readFileSync("package-lock.json"))
  .digest("hex");

if (!existsSync(receipt) || readFileSync(receipt, "utf8") !== lock) {
  execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { stdio: "inherit" });
  writeFileSync(receipt, lock);
}
