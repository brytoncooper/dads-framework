import {
  type ActiveTenant,
  TenantDirectory,
} from "../lib/ports/tenant-directory.js";

/**
 * A tenant directory for tests. Every id is active and named after itself
 * unless `name` names it; ids passed to `deactivate` are not active.
 */
export class FakeTenantDirectory extends TenantDirectory {
  private readonly names = new Map<string, string>();
  private readonly inactive = new Set<string>();

  name(id: string, name: string): this {
    this.names.set(id, name);
    return this;
  }

  deactivate(id: string): this {
    this.inactive.add(id);
    return this;
  }

  findActiveTenants(ids: readonly string[]): Promise<readonly ActiveTenant[]> {
    return Promise.resolve(
      ids
        .filter((id) => !this.inactive.has(id))
        .map((id) => ({ id, name: this.names.get(id) ?? id })),
    );
  }
}
