/**
 * Packing phase of the testing package proof: turn the two source packages
 * into tarballs and prove the tarballs carry exactly what a consumer is
 * promised — no `src/`, no `native/`, no Nx, no stray dependency.
 *
 * `verify-testing-package.mjs` owns the run; this module owns the packing and
 * the file-shape rules, plus the two small file readers both phases share.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

/** Fails loudly when `path` is not a readable, non-empty file. */
import { nativeNoticeFiles } from "./native-package-notices.mjs";

export function requireFile(path, label) {
  try {
    if (!statSync(path).isFile() || statSync(path).size === 0)
      throw new Error("not a non-empty file");
  } catch (error) {
    throw new Error(
      `Missing ${label}: ${path} (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function packPackage(
  root,
  packageDirectory,
  destinationDirectory,
  manifest,
  label,
) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(
    npm,
    [
      "pack",
      packageDirectory,
      "--pack-destination",
      destinationDirectory,
      "--json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const report = parsePackReport(output, label);
  const tarball = resolve(destinationDirectory, report.filename);
  if (dirname(tarball) !== resolve(destinationDirectory)) {
    throw new Error(
      `${label} npm pack filename escaped its temporary destination: ${report.filename}`,
    );
  }
  requireFile(tarball, `${label} tarball`);
  if (!tarball.endsWith(`-${manifest.version}.tgz`)) {
    throw new Error(
      `${label} tarball has an unexpected versioned filename: ${tarball}`,
    );
  }
  return { path: tarball, files: report.files };
}

function parsePackReport(output, label) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `npm pack returned invalid JSON for ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const report = Array.isArray(parsed) ? parsed[0] : undefined;
  if (
    report === undefined ||
    typeof report.filename !== "string" ||
    !Array.isArray(report.files)
  ) {
    throw new Error(`npm pack returned incomplete metadata for ${label}.`);
  }
  const files = report.files
    .map((entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "path" in entry &&
      typeof entry.path === "string"
        ? entry.path
        : undefined,
    )
    .filter((entry) => entry !== undefined);
  if (files.length !== report.files.length)
    throw new Error(`npm pack returned an invalid file list for ${label}.`);
  return { filename: report.filename, files };
}

export function verifyPackedContents(
  packed,
  label,
  manifest,
  nativePackageName,
) {
  const files = packed.files;
  const forbidden = files.filter(
    (file) =>
      /(^|\/)(src|native|target|node_modules)(\/|$)/.test(file) ||
      /(^|\/)nx(\/|$)/i.test(file),
  );
  if (forbidden.length > 0)
    throw new Error(
      `${label} package leaks forbidden source/runtime paths: ${forbidden.join(", ")}.`,
    );
  if (!files.includes("package.json") || !files.includes("README.md")) {
    throw new Error(`${label} package is missing package.json or README.md.`);
  }
  if (label === "facade") {
    if (
      !files.includes("bin/dad-test.js") ||
      !files.some((file) => file.startsWith("dist/"))
    ) {
      throw new Error(
        "Facade package is missing its CLI or built dist output.",
      );
    }
    if (
      manifest.dependencies?.nx !== undefined ||
      manifest.devDependencies?.nx !== undefined
    ) {
      throw new Error(
        "Facade package carries Nx as a runtime or development dependency.",
      );
    }
    if (files.some((file) => file.startsWith("native/")))
      throw new Error("Facade package embeds native artifacts.");
  } else {
    const expectedBinary =
      process.platform === "win32" ? "bin/dad-test.exe" : "bin/dad-test";
    const expectedFiles = [
      "package.json",
      "README.md",
      expectedBinary,
      ...nativeNoticeFiles,
    ];
    if (
      files.length !== expectedFiles.length ||
      expectedFiles.some((file) => !files.includes(file))
    ) {
      throw new Error(
        `${nativePackageName} package must contain its executable, manifest, README and license notices.`,
      );
    }
    if (
      manifest.dependencies !== undefined ||
      manifest.devDependencies !== undefined ||
      manifest.peerDependencies !== undefined
    ) {
      throw new Error(
        `${nativePackageName} package must not declare dependencies.`,
      );
    }
  }
}
