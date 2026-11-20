import { promises as fs } from "node:fs";
import path from "node:path";
import { isRecord } from "../parse-guards.js";

export { parseNxConfiguration } from "./nx-jsonc.js";

/** Resolves the Nx CLI installed by the supplied workspace. */
export async function resolveLocalNxCli(
  workspaceRoot: string,
): Promise<string> {
  const packageRoot = await resolvePackageRoot(workspaceRoot);
  const packageJson = path.join(packageRoot, "package.json");
  const packageDocument = await readInstalledNxManifest(packageJson);
  if (packageDocument["name"] !== "nx")
    throw new Error(
      `Installed package manifest ${packageJson} is not the Nx package.`,
    );
  const declared = readDeclaredNxBin(packageDocument, packageJson);
  const candidates =
    declared === undefined ? ["dist/bin/nx.js", "bin/nx.js"] : [declared];
  for (const candidate of candidates) {
    const cli = await resolveCliCandidate(
      packageRoot,
      candidate,
      packageJson,
      declared !== undefined,
    );
    if (cli !== undefined) return cli;
  }
  throw new Error(
    `Installed Nx package at ${packageJson} has no usable CLI entry; expected dist/bin/nx.js or bin/nx.js.`,
  );
}

async function resolvePackageRoot(workspaceRoot: string): Promise<string> {
  const workspace = path.resolve(workspaceRoot);
  let packageRoot: string;
  try {
    packageRoot = await fs.realpath(path.join(workspace, "node_modules", "nx"));
  } catch {
    throw new Error(
      `Refusing Nx import: no locally installed Nx package was found under ${workspace}/node_modules/nx.`,
    );
  }
  const packageJson = path.join(packageRoot, "package.json");
  try {
    await fs.access(packageJson);
  } catch {
    throw new Error(
      `Refusing Nx import: no locally installed Nx package was found at ${packageJson}.`,
    );
  }
  return packageRoot;
}

async function resolveCliCandidate(
  packageRoot: string,
  candidate: string,
  packageJson: string,
  explicitlyDeclared: boolean,
): Promise<string | undefined> {
  const resolved = validatePackagePath(packageRoot, candidate, packageJson);
  if (!(await isRegularFile(resolved))) {
    if (explicitlyDeclared)
      throw new Error(
        `Installed Nx package declares a missing CLI entry ${candidate} in ${packageJson}.`,
      );
    return undefined;
  }
  const realFile = await fs.realpath(resolved);
  if (
    realFile !== packageRoot &&
    !realFile.startsWith(`${packageRoot}${path.sep}`)
  )
    throw new Error(
      `Installed Nx package manifest ${packageJson} resolves its CLI outside the package: ${candidate}.`,
    );
  return realFile;
}

async function readInstalledNxManifest(
  filePath: string,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: unknown) {
    const detail =
      error instanceof Error ? error.message : "unknown JSON error";
    throw new Error(
      `Unable to parse installed Nx package manifest ${filePath}: ${detail}`,
      {
        cause: error,
      },
    );
  }
  if (!isRecord(parsed))
    throw new Error(
      `Installed Nx package manifest ${filePath} must be a JSON object.`,
    );
  return parsed;
}

function readDeclaredNxBin(
  packageDocument: Record<string, unknown>,
  packageJson: string,
): string | undefined {
  const bin = packageDocument["bin"];
  if (bin === undefined) return undefined;
  if (typeof bin === "string") return bin;
  if (!isRecord(bin))
    throw new Error(
      `Installed Nx package manifest ${packageJson} has malformed bin; expected a string or bin.nx.`,
    );
  const nx = bin["nx"];
  if (typeof nx !== "string" || nx.length === 0)
    throw new Error(
      `Installed Nx package manifest ${packageJson} has malformed bin.nx; expected a non-empty string.`,
    );
  return nx;
}

function validatePackagePath(
  packageRoot: string,
  candidate: string,
  packageJson: string,
): string {
  if (candidate.length === 0 || path.isAbsolute(candidate))
    throw new Error(
      `Installed Nx package manifest ${packageJson} has an invalid CLI path ${JSON.stringify(candidate)}.`,
    );
  const resolved = path.resolve(packageRoot, candidate);
  if (
    resolved !== packageRoot &&
    !resolved.startsWith(`${packageRoot}${path.sep}`)
  )
    throw new Error(
      `Installed Nx package manifest ${packageJson} declares a CLI path outside the package: ${candidate}.`,
    );
  return resolved;
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}
