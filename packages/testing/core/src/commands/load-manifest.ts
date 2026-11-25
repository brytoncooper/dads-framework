import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { DadTestCliIo } from "../dad-test-cli.js";
import { isRecord } from "../parse-guards.js";
import { expandTestingManifest } from "../testing-api.js";
import { defaultTestingManifestFileName, parseTestingManifest, type TestingManifest } from "../testing-manifest.js";

/**
 * Reads a workspace manifest for CLI commands (`explain`, `--report`), expanding
 * declarative `workspace.discover` manifests through the native engine while
 * parsing static manifests directly without an extra subprocess.
 */
export async function loadTestingManifestForCommand(
  io: DadTestCliIo,
  manifestPath: string | undefined,
): Promise<TestingManifest> {
  const requestedPath = manifestPath ?? defaultTestingManifestFileName;
  const rawText = readManifestTextInsideWorkspace(io.cwd, requestedPath);
  if (declaresWorkspaceDiscover(rawText)) {
    return expandTestingManifest({
      workspaceRoot: io.cwd,
      ...(manifestPath === undefined ? {} : { manifestPath }),
      ...(io.nativeBinary === undefined ? {} : { nativeBinary: io.nativeBinary }),
    });
  }
  return parseTestingManifest(rawText, requestedPath);
}

function readManifestTextInsideWorkspace(workspaceRoot: string, requestedPath: string): string {
  const root = resolve(workspaceRoot);
  const resolvedPath = resolve(root, requestedPath);
  if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${sep}`)) {
    throw new Error(`The manifest path must stay inside the workspace: ${requestedPath}`);
  }
  return readFileSync(resolvedPath, "utf8");
}

function declaresWorkspaceDiscover(rawText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (!isRecord(parsed)) return false;
    const workspace = parsed["workspace"];
    return isRecord(workspace) && workspace["discover"] !== undefined;
  } catch {
    return false;
  }
}
