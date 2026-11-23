import { createRequire } from "node:module";

export const requireAwsSdk = createRequire(import.meta.url);

export function resolveAwsSdk(packageName: string, feature: string): void {
  try {
    requireAwsSdk.resolve(packageName);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") {
      throw new Error(
        `${feature} requires ${packageName}. Install it in the consuming application with npm install ${packageName}.`,
        { cause: error },
      );
    }
    throw error;
  }
}
