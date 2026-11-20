import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { releaseWorkspaces } from "./release-workspaces.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const approved = readFileSync(resolve(root, "LICENSE.md"));
const workspaces = releaseWorkspaces(root);
const facade = JSON.parse(
  readFileSync(resolve(root, "packages/testing/core/package.json"), "utf8"),
);
const project = JSON.parse(
  readFileSync(resolve(root, "dads.project.json"), "utf8"),
);
const native = Object.keys(facade.optionalDependencies ?? {}).map((name) => {
  const directory = project.packages.find((entry) => entry.name === name)?.root;
  if (!directory?.startsWith("packages/testing/native/")) {
    throw new Error(
      `Native package ${name} has no declared release directory.`,
    );
  }
  return { name, directory };
});
const packages = [...workspaces, ...native];

for (const { name, directory } of packages) {
  const path = resolve(root, directory, "LICENSE.md");
  try {
    writeFileSync(path, approved, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!readFileSync(path).equals(approved)) {
      throw new Error(
        `${name} has a different MIT notice. Review it before proceeding.`,
        {
          cause: error,
        },
      );
    }
  }
}
process.stdout.write(
  `Verified the MIT notice for ${packages.length} release packages.\n`,
);
