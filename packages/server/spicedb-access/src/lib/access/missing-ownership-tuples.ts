/**
 * Domain-owned ownership reconciliation seam (docs/architecture/authorization.md).
 * Each domain contributes an audit via compose*(); the composition root
 * registers them; domains never import each other.
 */

export type MissingOwnershipTuple = {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly kind: "missingTuple";
  readonly expectedRelation: string;
};

/**
 * Report-only check: durable rows that should carry a parent authz fact.
 * Implementations live in the owning domain next to its readers.
 */
export abstract class MissingOwnershipTuples {
  abstract run(): Promise<readonly MissingOwnershipTuple[]>;
}
