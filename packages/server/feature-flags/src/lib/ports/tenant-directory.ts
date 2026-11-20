/** One tenant the application says is active, with the name management shows. */
export type ActiveTenant = {
  readonly id: string;
  readonly name: string;
};

/**
 * The application's answer to "what is a tenant?". Absorbs the tenant model:
 * a company table, a team list, a project registry. The package only asks
 * which of some ids are active, and what they are called.
 */
export abstract class TenantDirectory {
  /** The active tenants among `ids`; an unknown or inactive id is left out. */
  abstract findActiveTenants(
    ids: readonly string[],
  ): Promise<readonly ActiveTenant[]>;
}
