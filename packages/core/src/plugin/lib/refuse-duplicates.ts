import { PluginCompositionError } from "./plugin-errors.js";

/** One claimed key and the plugin that claimed it. */
export type Claim = { readonly key: string; readonly pluginName: string };

/**
 * Refuse a key two plugins claim (two jobs named alike, two flags with one
 * slug). The error names both plugins, which a vendor's own duplicate check
 * downstream cannot.
 */
export function refuseDuplicates(what: string, claims: readonly Claim[]): void {
  const owners = new Map<string, string>();
  for (const claim of claims) {
    const owner = owners.get(claim.key);
    if (owner !== undefined) {
      throw new PluginCompositionError(
        `${what} ${claim.key} is contributed by both ${owner} and ${claim.pluginName}`,
      );
    }
    owners.set(claim.key, claim.pluginName);
  }
}
