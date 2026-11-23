import { createHash } from "node:crypto";
import { copyFileSync, constants, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";
import { nativeArchiveRustTarget } from "./native-executable.mjs";
import { releaseVersion } from "./release-version.mjs";

const [inputs, output] = process.argv.slice(2);
if (!inputs || !output) throw new Error("Expected native input and release output directories.");

const version = releaseVersion(process.cwd());
const entries = readdirSync(inputs, { withFileTypes: true });
if (entries.length !== 5 || entries.some((entry) => !entry.isDirectory())) {
  throw new Error("Expected five hosted native matrix artifacts.");
}
for (const entry of entries) {
  const directory = join(inputs, entry.name);
  const build = JSON.parse(readFileSync(join(directory, "build.json"), "utf8"));
  if (
    build.repository !== process.env.GITHUB_REPOSITORY ||
    build.commit !== process.env.GITHUB_SHA ||
    build.runId !== process.env.GITHUB_RUN_ID ||
    build.runAttempt !== process.env.GITHUB_RUN_ATTEMPT ||
    entry.name !== `dads-testing-native-${build.target}-${build.runAttempt}` ||
    !Array.isArray(build.files) ||
    build.files.length !== 2
  )
    throw new Error(`Unexpected native build record in ${entry.name}.`);
  const native = build.files.filter(({ name }) => {
    const target = nativeArchiveRustTarget(name, version);
    return target !== undefined && target === build.target;
  });
  if (native.length !== 1) throw new Error(`Missing native archive in ${entry.name}.`);
  const [{ name, sha256 }] = native;
  if (basename(name) !== name) throw new Error("Invalid native archive filename.");
  const archive = join(directory, name);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (digest !== sha256) throw new Error(`Native archive checksum differs in ${entry.name}.`);
  copyFileSync(archive, join(output, name), constants.COPYFILE_EXCL);
}
