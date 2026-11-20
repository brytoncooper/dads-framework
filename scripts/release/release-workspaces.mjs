import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import process from "node:process";

export function releaseWorkspaces(root) {
  const project = JSON.parse(
    readFileSync(resolve(root, "dads.project.json"), "utf8"),
  );
  const roots = new Map(
    project.packages.map((entry) => [entry.name, entry.root]),
  );
  const npmExecutable = process.platform === "win32" ? process.execPath : "npm";
  const npmArguments =
    process.platform === "win32"
      ? [resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")]
      : [];
  const manifests = JSON.parse(
    execFileSync(
      npmExecutable,
      [
        ...npmArguments,
        "pkg",
        "get",
        "name",
        "private",
        "license",
        "scripts",
        "--workspaces",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ),
  );
  return Object.values(manifests)
    .filter((manifest) => manifest.private !== true)
    .map((manifest) => {
      const directory = roots.get(manifest.name);
      if (!directory || manifest.license !== "MIT") {
        throw new Error(
          "Every release workspace must be declared and MIT licensed.",
        );
      }
      if (
        ["prepack", "prepare", "postpack"].some(
          (key) => manifest.scripts?.[key],
        )
      ) {
        throw new Error(
          "Release workspaces must build artifacts before packing.",
        );
      }
      const prepublish = posix.relative(
        directory,
        "scripts/verify-prepublish.mjs",
      );
      if (manifest.scripts?.prepublishOnly !== `node ${prepublish}`) {
        throw new Error(
          `${manifest.name} is missing the shared package publication guard.`,
        );
      }
      return { name: manifest.name, directory };
    });
}
