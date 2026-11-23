import { createHash, randomBytes } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function readLocalState(root, initialize) {
  const dataDirectory = join(root, ".dads");
  const file = join(dataDirectory, "local-dev.json");
  if (initialize) initializeState(dataDirectory, file);
  try {
    if (!lstatSync(file).isFile()) throw new Error("Local development state must be a regular file.");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  const { databasePassword, identitySecret } = JSON.parse(readFileSync(file, "utf8"));
  if (![databasePassword, identitySecret].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) {
    throw new Error("Local development state is invalid. Restore .dads/local-dev.json before starting.");
  }
  return {
    project: `dads-${createHash("sha256").update(root).digest("hex").slice(0, 20)}`,
    databasePassword,
    identitySecret,
  };
}

function initializeState(directory, file) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `local-dev-${randomBytes(12).toString("hex")}.tmp`);
  try {
    writeFileSync(
      temporary,
      JSON.stringify({
        databasePassword: randomBytes(32).toString("hex"),
        identitySecret: randomBytes(32).toString("hex"),
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    try {
      linkSync(temporary, file);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}
