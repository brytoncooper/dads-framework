/**
 * The vocabulary one declared cross-domain reference is written in.
 *
 * ADR-0023 trades database enforcement for modularity: a reference that
 * crosses a domain boundary is an indexed scalar id with no foreign key. The
 * trade is only honest if the integrity nobody is enforcing is VERIFIED, so
 * every such column is declared as data by the domain that holds it and
 * checked against a real database
 * (docs/architecture/data-modeling.md#verifying-the-references-no-one-constrains).
 *
 * These are the words; `declare-cross-domain-references.ts` is how a domain
 * says them and how a product collects them.
 */

/**
 * ADR-0023's relationship classification, carried on every row so a finding
 * reads with the policy that governs its repair.
 *
 * `historical-document` — the consumer recorded what was true at a business
 * event and keeps its own snapshot labels. A dangling id is a broken NAVIGATION
 * link; history is never rewritten to repair it.
 *
 * `live-association` — current provider state affects whether new consumer
 * action is valid. A dangling id is a live integrity break and belongs to the
 * consuming domain's repair path.
 */
export type ReferenceClassification =
  "historical-document" | "live-association";

/** One `<column> = '<value>'` condition that narrows which rows a row applies to. */
export type ReferenceFilter = {
  readonly column: string;
  readonly equals: string;
};

/**
 * A discriminator that does not live on the referencing row itself.
 *
 * `permission_set_assignments.membership_id` points at an organization
 * membership or a facility membership, and the row carrying that answer is the
 * parent `permission_sets.scope_type` reached through `permission_set_id`.
 * Without this hop the column cannot be resolved at all, so it is modelled
 * rather than skipped.
 */
export type ParentDiscriminator = {
  readonly table: string;
  /** Column on the referencing row that names the parent. */
  readonly localColumn: string;
  /** Column on the parent the local column matches. */
  readonly parentColumn: string;
  readonly filters: readonly ReferenceFilter[];
};

/** One registered reference: which column points at which table's key. */
export type CrossDomainReference = {
  /** Stable slug used in reports and in the seeded-violation proof. */
  readonly id: string;
  readonly consumerDomain: string;
  readonly consumerTable: string;
  readonly consumerColumn: string;
  readonly providerDomain: string;
  readonly providerTable: string;
  readonly providerColumn: string;
  readonly classification: ReferenceClassification;
  /** Conditions on the referencing row — a polymorphic column's own `*_type`. */
  readonly filters?: readonly ReferenceFilter[];
  /** Conditions on a parent row, when the discriminator is not local. */
  readonly discriminatedByParent?: ParentDiscriminator;
  /**
   * The consumer column is an ARRAY of ids (`uuid[]`), and every element is
   * one reference. Each element is checked on its own; an empty array holds
   * no reference, exactly as a null scalar does.
   */
  readonly consumerHoldsMany?: true;
};

/** One reference's findings against one database. */
export type DanglingReferenceFinding = {
  readonly reference: CrossDomainReference;
  /** Referencing rows whose id matches no provider row. */
  readonly rows: number;
  /** Distinct dangling id values behind those rows. */
  readonly distinctValues: number;
  /** Up to `SAMPLE_LIMIT` of those values, worst-count first. */
  readonly sampleIds: readonly string[];
};

/** How many dangling ids a finding carries, so a report stays readable. */
export const SAMPLE_LIMIT = 5;

/**
 * Who mints a branded id when the table's primary key cannot say so itself.
 *
 * The reference check derives brand ownership from
 * the schema: the domain whose table declares
 * `id: ….primaryKey()….$type<XId>()` owns `XId`. Vendored tables break that,
 * because their schema is not ours to brand — Better Auth owns its own, so
 * `user.id` and `sso_provider.id` are plain text columns. Declaring the owner
 * beside the domain's references is what lets the rule see a `UserId` column in
 * another domain as the cross-domain reference it is. An owner naming a table
 * no table file declares is a detect error.
 */
export type CrossDomainBrandOwner = {
  /** The id brand, e.g. "UserId". */
  readonly brand: string;
  /** The vendored table whose unbranded primary key mints these ids. */
  readonly table: string;
};
