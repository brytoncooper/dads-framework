/**
 * How a domain declares the loose references it holds, and how a product
 * collects them.
 *
 * There is no central registry. A reference belongs to the domain whose table
 * carries the id, so the declaration sits in that domain beside the column it
 * describes, and the product's composition root assembles one list out of them
 * (every product runs the dangling-reference check over its own
 * references).
 *
 * Both calls are walls, not decoration. They run at module load, so a
 * declaration that cannot be checked correctly fails the BOOT of anything that
 * imports it rather than quietly reporting the wrong rows.
 */
import type {
  CrossDomainBrandOwner,
  CrossDomainReference,
} from "./cross-domain-reference.js";

/**
 * One domain's loose cross-domain references.
 *
 * Two things must hold inside a domain, and both are checked here because a
 * violation makes the CHECK wrong rather than the schema wrong:
 *
 *   - ids are unique, because a finding is reported by its id;
 *   - a column declared more than once is narrowed by a discriminator. A
 *     polymorphic column declared twice without one reports every other arm's
 *     rows as dangling and never proves its own.
 */
export function declareCrossDomainReferences(
  references: readonly CrossDomainReference[],
): readonly CrossDomainReference[] {
  refuseDuplicateIds(references, "declared in one domain");

  for (const reference of references) {
    const column = `${reference.consumerTable}.${reference.consumerColumn}`;
    const arms = references.filter(
      (other) =>
        other.consumerTable === reference.consumerTable &&
        other.consumerColumn === reference.consumerColumn,
    );
    if (arms.length === 1 || isNarrowed(reference)) continue;
    throw new Error(
      `cross-domain reference \`${reference.id}\` shares column \`${column}\` with ${String(arms.length - 1)} other declaration(s) and narrows nothing — a polymorphic column needs \`filters\` or \`discriminatedByParent\` on every arm`,
    );
  }

  return references;
}

/**
 * One product's whole list, assembled from its domains' declarations.
 *
 * An EMPTY result is valid and means what it says: this product declares no
 * cross-domain reference yet. It is not silence — the check still runs, and
 * reports that it checked nothing.
 */
export function assembleCrossDomainReferences(
  declarations: readonly (readonly CrossDomainReference[])[],
): readonly CrossDomainReference[] {
  const assembled = declarations.flat();
  refuseDuplicateIds(assembled, "assembled for one product");
  return assembled;
}

/**
 * The brands a domain's vendored tables mint, when the primary key cannot
 * carry the brand itself. Data for the detector, never read at runtime.
 */
export function declareCrossDomainBrandOwners(
  owners: readonly CrossDomainBrandOwner[],
): readonly CrossDomainBrandOwner[] {
  const brands = owners.map((owner) => owner.brand);
  const duplicate = brands.find(
    (brand, index) => brands.indexOf(brand) !== index,
  );
  if (duplicate !== undefined) {
    throw new Error(
      `brand \`${duplicate}\` is declared by two tables — a brand has one minting table or none`,
    );
  }
  return owners;
}

function isNarrowed(reference: CrossDomainReference): boolean {
  return (
    (reference.filters ?? []).length > 0 ||
    reference.discriminatedByParent !== undefined
  );
}

function refuseDuplicateIds(
  references: readonly CrossDomainReference[],
  scope: string,
): void {
  const ids = references.map((reference) => reference.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw new Error(
      `two cross-domain references ${scope} share the id \`${duplicate}\` — findings are reported by id, so it has to be unique`,
    );
  }
}
