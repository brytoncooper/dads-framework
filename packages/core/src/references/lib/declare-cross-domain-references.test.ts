/**
 * The two walls a declaration passes before anything checks it.
 *
 * Both used to be unit tests over one central registry file. They are calls
 * now, so a domain that breaks either fails at import rather than at whichever
 * test happened to still be reading the whole list.
 */
import { describe, expect, it } from "vitest";

import type { CrossDomainReference } from "./cross-domain-reference.js";
import {
  assembleCrossDomainReferences,
  declareCrossDomainBrandOwners,
  declareCrossDomainReferences,
} from "./declare-cross-domain-references.js";

const reference: CrossDomainReference = {
  id: "orders.managing_organization_id",
  consumerDomain: "orders",
  consumerTable: "orders",
  consumerColumn: "managing_organization_id",
  providerDomain: "organizations",
  providerTable: "organizations",
  providerColumn: "id",
  classification: "live-association",
};

describe("declareCrossDomainReferences", () => {
  it("returns what it was given", () => {
    expect(declareCrossDomainReferences([reference])).toEqual([reference]);
  });

  it("refuses two declarations sharing an id, because findings name it", () => {
    expect(() => declareCrossDomainReferences([reference, { ...reference }])).toThrow(/share the id/);
  });

  /**
   * A polymorphic column declared twice without a discriminator is wrong
   * twice over: it reports every other arm's rows as dangling, and it never
   * proves its own.
   */
  it("refuses a column declared twice with nothing narrowing it", () => {
    expect(() =>
      declareCrossDomainReferences([
        { ...reference, id: "orders.subject_id[SET]" },
        { ...reference, id: "orders.subject_id[MEMBERSHIP]" },
      ]),
    ).toThrow(/narrows nothing/);
  });

  it("accepts the same column twice when every arm is narrowed", () => {
    const arms = [
      {
        ...reference,
        id: "orders.subject_id[SET]",
        filters: [{ column: "subject_kind", equals: "SET" }],
      },
      {
        ...reference,
        id: "orders.subject_id[MEMBERSHIP]",
        filters: [{ column: "subject_kind", equals: "MEMBERSHIP" }],
      },
    ];

    expect(declareCrossDomainReferences(arms)).toHaveLength(2);
  });
});

describe("assembleCrossDomainReferences", () => {
  it("flattens every domain's declarations into the product's list", () => {
    const assembled = assembleCrossDomainReferences([
      [reference],
      [{ ...reference, id: "facilities.owner_organization_id" }],
    ]);

    expect(assembled.map((row) => row.id)).toEqual([
      "orders.managing_organization_id",
      "facilities.owner_organization_id",
    ]);
  });

  /** A product with nothing to declare says so; silence is not the same thing. */
  it("accepts a product that declares nothing", () => {
    expect(assembleCrossDomainReferences([])).toEqual([]);
  });

  it("refuses two domains claiming one id", () => {
    expect(() => assembleCrossDomainReferences([[reference], [reference]])).toThrow(/share the id/);
  });
});

describe("declareCrossDomainBrandOwners", () => {
  it("refuses two tables minting one brand", () => {
    expect(() =>
      declareCrossDomainBrandOwners([
        { brand: "UserId", table: "user" },
        { brand: "UserId", table: "account" },
      ]),
    ).toThrow(/one minting table/);
  });
});
