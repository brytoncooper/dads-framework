import type { TestingOperationRequest } from "../index.js";
import { nativeNxProcess } from "./nx-native-process.js";

/** A live graph describes the checkout, never a different historical head. */
export async function requireNativeNxScope(
  request: TestingOperationRequest,
): Promise<void> {
  if (
    request.all &&
    (request.base !== undefined || request.head !== undefined)
  ) {
    throw new Error("--all cannot be combined with --base or --head.");
  }
  if (request.head === undefined) return;
  if (request.base === undefined) throw new Error("--head requires --base.");
  const [head, requested, status] = await Promise.all([
    nativeNxProcess(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      request.workspaceRoot,
    ),
    nativeNxProcess(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${request.head}^{commit}`],
      request.workspaceRoot,
    ),
    nativeNxProcess(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      request.workspaceRoot,
    ),
  ]);
  if (head.trim() !== requested.trim() || status.trim() !== "") {
    throw new Error(
      "Nx --head planning requires that revision to be the clean checked-out HEAD. Omit --head to analyze working-tree changes.",
    );
  }
}
