const MISSING_MODULE_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * True when a dynamic import failed because the target module is not installed.
 * Other errors (syntax errors, initialization crashes inside the peer) return
 * false so real bugs are not disguised as missing packages.
 */
export function isMissingModuleError(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== undefined && MISSING_MODULE_CODES.has(code)) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  return error.message.includes("Cannot find package") || error.message.includes("Cannot find module");
}

/**
 * Loads an optional peer dependency and replaces raw module-not-found errors
 * with an actionable install hint naming the subpath and peer package.
 */
export async function loadOptionalPeer<TModule>(
  subpath: string,
  packageName: string,
  load: () => Promise<TModule>,
): Promise<TModule> {
  try {
    return await load();
  } catch (error: unknown) {
    if (isMissingModuleError(error)) {
      throw new Error(
        `${subpath} requires optional peer dependency "${packageName}". Install it with: npm install ${packageName}`,
        { cause: error },
      );
    }
    throw error;
  }
}
