import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { loadPrivatePatterns } from "../checks/check-private-references.mjs";
import { auditPackage } from "./artifact-policy.mjs";
import { nativeArchiveTarget, verifyNativeExecutable } from "./native-executable.mjs";
import {
  TESTING_FACADE_PACKAGE,
  expectedPackageVersion,
  normalizeReleaseScope,
  testingReleaseVersion,
} from "./release-version.mjs";
import { releaseWorkspaces } from "./release-workspaces.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));

function pack(root, packages, scratch) {
  const command = [
    "pack",
    "--offline",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    scratch,
    ...packages.flatMap((name) => ["-w", name]),
  ];
  return JSON.parse(
    execFileSync("npm", command, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

function extract(scratch, unpacked, record, index) {
  if (basename(record.filename) !== record.filename || !record.filename.endsWith(".tgz")) {
    throw new Error("Unexpected package archive name.");
  }
  const archive = record.archive ?? join(scratch, record.filename);
  const digest = createHash("sha512").update(readFileSync(archive)).digest("base64");
  if (record.integrity !== `sha512-${digest}`) {
    throw new Error("A local archive does not match the npm pack integrity.");
  }
  const destination = join(unpacked, String(index));
  mkdirSync(destination);
  const outcome = spawnSync("tar", ["-xzf", archive, "-C", destination], {
    stdio: "ignore",
  });
  if (outcome.status !== 0) throw new Error("A local archive could not be unpacked.");
  return join(destination, "package");
}

function nativeRecords(outputDirectory, version) {
  return readdirSync(outputDirectory)
    .filter((filename) => filename.endsWith(".tgz"))
    .map((filename) => {
      if (!nativeArchiveTarget(filename, version)) {
        throw new Error("Only hosted native archives may be prepopulated in the release output directory.");
      }
      const archive = join(outputDirectory, filename);
      return {
        archive,
        filename,
        name: filename.slice(0, -".tgz".length),
        integrity: `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`,
        files: execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
          .trim()
          .split("\n")
          .filter((path) => !path.endsWith("/"))
          .map((path) => {
            if (!path.startsWith("package/") || path.split("/").includes("..")) {
              throw new Error("A native archive contains an invalid package path.");
            }
            return { path: path.slice("package/".length) };
          }),
      };
    });
}

function scanWithGitleaks(target) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GITLEAKS_")));
  const result = spawnSync("gitleaks", ["dir", target, "--redact=100", "--no-banner", "--ignore-gitleaks-allow"], {
    stdio: "ignore",
    env,
    cwd: target,
  });
  if (result.status !== 0) {
    process.stderr.write("Gitleaks must be installed and pass on the extracted release archives.\n");
    throw new Error("Secret scan failed.");
  }
}

export function verifyReleaseArtifacts(root = repository, packageName, outputDirectory, scope = "all") {
  const normalizedScope = normalizeReleaseScope(scope);
  const testingVersion = testingReleaseVersion(root);
  const workspaces = releaseWorkspaces(root);
  const scopedWorkspaces =
    normalizedScope === "testing" ? workspaces.filter(({ name }) => name === TESTING_FACADE_PACKAGE) : workspaces;
  const packages = scopedWorkspaces.map(({ name }) => name).filter((name) => !packageName || packageName === name);
  if (packages.length === 0) throw new Error("No eligible release workspace matches the request.");

  const privateFile = process.env.DADS_RELEASE_PRIVATE_PATTERNS;
  const privatePatterns = loadPrivatePatterns(root, privateFile ? resolve(root, privateFile) : undefined);
  const license = readFileSync(join(root, "LICENSE.md"));
  const scratch = mkdtempSync(join(tmpdir(), "dads-release-preflight-"));
  try {
    const unpacked = join(scratch, "unpacked");
    mkdirSync(unpacked);
    const records = pack(root, packages, scratch);
    const expectedPackages = new Set(packages);
    const native = outputDirectory ? nativeRecords(outputDirectory, testingVersion) : [];
    if (outputDirectory && native.length !== 5) {
      throw new Error("Expected five verified native archives in the release output directory.");
    }
    let violations = 0;
    for (const [index, record] of [...records, ...native].entries()) {
      if (!record.archive && !expectedPackages.delete(record.name)) {
        throw new Error("The packed package list does not match the requested workspaces.");
      }
      const directory = extract(scratch, unpacked, record, index);
      if (!record.archive) {
        const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        const expectedVersion = expectedPackageVersion(root, manifest.name);
        if (manifest.version !== expectedVersion) {
          throw new Error(`Unexpected release version in ${record.filename}.`);
        }
      }
      const nativeExecutable = record.archive
        ? verifyNativeExecutable(directory, record.filename, testingVersion)
        : undefined;
      for (const [rule, count] of auditPackage(directory, record.files, license, privatePatterns, nativeExecutable)) {
        process.stderr.write(`Release blocked for ${record.name}: ${rule} (${count} files).\n`);
        violations += count;
      }
    }
    if (expectedPackages.size > 0) {
      throw new Error("Requested packages were absent from the pack result.");
    }
    if (violations > 0) throw new Error("Release artifact policy failed.");
    scanWithGitleaks(unpacked);
    if (outputDirectory) {
      for (const { filename } of records) {
        copyFileSync(join(scratch, filename), join(outputDirectory, filename), constants.COPYFILE_EXCL);
      }
    }
    process.stdout.write(`Release preflight passed for ${packages.length + native.length} packages.\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function parsePackPreflightArgs(argv) {
  let packageName;
  let outputDirectory;
  let scope = "all";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-") || outputDirectory !== undefined) {
        throw new Error("Expected one release output directory.");
      }
      outputDirectory = resolve(value);
      index += 1;
    } else if (arg === "--scope") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Expected --scope all|testing.");
      }
      scope = normalizeReleaseScope(value);
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      if (packageName !== undefined) {
        throw new Error("Expected at most one package name.");
      }
      packageName = arg;
    }
  }
  if (packageName !== undefined && outputDirectory !== undefined) {
    throw new Error("Cannot combine a single package name with --output.");
  }
  return { packageName, outputDirectory, scope };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { packageName, outputDirectory, scope } = parsePackPreflightArgs(process.argv.slice(2));
    verifyReleaseArtifacts(repository, packageName, outputDirectory, scope);
  } catch {
    process.stderr.write("Release preflight failed. No artifacts were approved.\n");
    process.exitCode = 1;
  }
}
