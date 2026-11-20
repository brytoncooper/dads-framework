/**
 * The seeded-violation proof for ADR-0023's detection wall.
 *
 * A checker that has never caught anything is indistinguishable from a checker
 * that cannot catch anything. So this suite writes the corruption a database
 * with no foreign keys is not allowed to refuse — a row naming an owner that
 * does not exist, two rows naming the same absent owner, a polymorphic arm
 * whose discriminator lives on a parent — and proves the checker names it and
 * leaves the other arms alone.
 *
 * The tables are the SUITE's own, created here and dropped after. The engine
 * never learns a table name, so neither does its proof: a product's own
 * declarations are checked against that product's migrated schema where those
 * declarations live in the application.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  startTestPostgres,
  type TestPostgres,
} from "@dads-framework/postgres/testing";
import { deterministicUuid } from "@dads-framework/postgres/testing/deterministic-uuid";

import type { CrossDomainReference } from "../cross-domain-reference.js";
import { checkCrossDomainReferences } from "./check-cross-domain-references.js";

/** Ids no row was ever written for — the dangling references under test. */
const ABSENT_OWNER = deterministicUuid("absent-owner", 1);
const ABSENT_MEMBER = deterministicUuid("absent-member", 1);

const SCHEMA = [
  `CREATE TABLE reference_check_owners (id uuid PRIMARY KEY)`,
  `CREATE TABLE reference_check_documents (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     owner_id uuid,
     subject_id uuid,
     subject_kind text
   )`,
  `CREATE TABLE reference_check_sets (id uuid PRIMARY KEY, scope_type text NOT NULL)`,
  `CREATE TABLE reference_check_bundles (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     owner_ids uuid[] NOT NULL
   )`,
  `CREATE TABLE reference_check_set_members (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     set_id uuid NOT NULL,
     member_id uuid
   )`,
];

const SEEDED_TABLES = [
  "reference_check_bundles",
  "reference_check_set_members",
  "reference_check_sets",
  "reference_check_documents",
  "reference_check_owners",
];

/** The plain case: an id column pointing at another table's key. */
const DOCUMENT_OWNER: CrossDomainReference = {
  id: "reference_check_documents.owner_id",
  consumerDomain: "documents",
  consumerTable: "reference_check_documents",
  consumerColumn: "owner_id",
  providerDomain: "owners",
  providerTable: "reference_check_owners",
  providerColumn: "id",
  classification: "live-association",
};

/** The array case: every element of a `uuid[]` column is one reference. */
const BUNDLE_OWNERS: CrossDomainReference = {
  id: "reference_check_bundles.owner_ids",
  consumerDomain: "bundles",
  consumerTable: "reference_check_bundles",
  consumerColumn: "owner_ids",
  providerDomain: "owners",
  providerTable: "reference_check_owners",
  providerColumn: "id",
  classification: "live-association",
  consumerHoldsMany: true,
};

/** The polymorphic case: the discriminator is on the referencing row. */
const DOCUMENT_OWNER_SUBJECT: CrossDomainReference = {
  id: "reference_check_documents.subject_id[OWNER]",
  consumerDomain: "documents",
  consumerTable: "reference_check_documents",
  consumerColumn: "subject_id",
  providerDomain: "owners",
  providerTable: "reference_check_owners",
  providerColumn: "id",
  classification: "live-association",
  filters: [{ column: "subject_kind", equals: "OWNER" }],
};

/** The hard case: the discriminator lives on a parent row. */
function memberThroughSetScope(scope: string): CrossDomainReference {
  return {
    id: `reference_check_set_members.member_id[${scope}]`,
    consumerDomain: "sets",
    consumerTable: "reference_check_set_members",
    consumerColumn: "member_id",
    providerDomain: "owners",
    providerTable: "reference_check_owners",
    providerColumn: "id",
    classification: "live-association",
    discriminatedByParent: {
      table: "reference_check_sets",
      localColumn: "set_id",
      parentColumn: "id",
      filters: [{ column: "scope_type", equals: scope }],
    },
  };
}

describe("cross-domain reference check (integration)", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startTestPostgres();
    for (const statement of SCHEMA) await postgres.pool.query(statement);
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  beforeEach(async () => {
    await postgres.pool.query(`TRUNCATE ${SEEDED_TABLES.join(", ")}`);
  });

  it("names a document whose owner does not exist", async () => {
    await seedDocument(postgres, { ownerId: ABSENT_OWNER });

    const findings = await checkCrossDomainReferences(postgres.pool, [
      DOCUMENT_OWNER,
    ]);

    expect(findings).toEqual([
      {
        reference: DOCUMENT_OWNER,
        rows: 1,
        distinctValues: 1,
        sampleIds: [ABSENT_OWNER],
      },
    ]);
  });

  it("counts rows and distinct ids separately", async () => {
    await seedDocument(postgres, { ownerId: ABSENT_OWNER });
    await seedDocument(postgres, { ownerId: ABSENT_OWNER });

    const [finding] = await checkCrossDomainReferences(postgres.pool, [
      DOCUMENT_OWNER,
    ]);

    expect(finding?.rows).toBe(2);
    expect(finding?.distinctValues).toBe(1);
  });

  it("accepts a reference whose provider row exists", async () => {
    const present = deterministicUuid("present-owner", 1);
    await postgres.pool.query(
      `INSERT INTO reference_check_owners (id) VALUES ($1)`,
      [present],
    );
    await seedDocument(postgres, { ownerId: present });

    const findings = await checkCrossDomainReferences(postgres.pool, [
      DOCUMENT_OWNER,
    ]);

    expect(findings).toEqual([]);
  });

  it("skips a null reference — absence is a valid state, not a break", async () => {
    await seedDocument(postgres, { ownerId: null });

    const findings = await checkCrossDomainReferences(postgres.pool, [
      DOCUMENT_OWNER,
    ]);

    expect(findings).toEqual([]);
  });

  /**
   * A polymorphic column's other arms are not this arm's business: without the
   * discriminator the check reports every arm's rows as dangling and proves
   * none of them.
   */
  it("checks only the arm its own discriminator names", async () => {
    await seedDocument(postgres, {
      subjectId: ABSENT_OWNER,
      subjectKind: "SOMETHING-ELSE",
    });

    const findings = await checkCrossDomainReferences(postgres.pool, [
      DOCUMENT_OWNER_SUBJECT,
    ]);

    expect(findings).toEqual([]);
  });

  /**
   * The reason a parent discriminator is modelled at all: the referencing row
   * says nothing about which table its id belongs to, and the answer is the
   * parent's scope, reached through the one key it does have.
   */
  it("resolves an arm through its parent's scope", async () => {
    await seedSetMember(postgres, "ORGANIZATION", ABSENT_MEMBER);

    const organizationArm = await checkCrossDomainReferences(postgres.pool, [
      memberThroughSetScope("ORGANIZATION"),
    ]);
    const facilityArm = await checkCrossDomainReferences(postgres.pool, [
      memberThroughSetScope("FACILITY"),
    ]);

    expect(organizationArm.map((finding) => finding.sampleIds)).toEqual([
      [ABSENT_MEMBER],
    ]);
    expect(facilityArm).toEqual([]);
  });

  /**
   * A declaration naming a column the database does not have is a finding
   * about the declaration, and it has to say which one went stale rather than
   * reporting zero dangling rows.
   */
  it("checks each element of an array column, and an empty array holds nothing", async () => {
    const present = deterministicUuid("present-owner", 1);
    await postgres.pool.query(
      `INSERT INTO reference_check_owners (id) VALUES ($1)`,
      [present],
    );
    await postgres.pool.query(
      `INSERT INTO reference_check_bundles (owner_ids) VALUES ($1), ($2), ($3)`,
      [[present, ABSENT_OWNER], [ABSENT_OWNER], []],
    );

    const findings = await checkCrossDomainReferences(postgres.pool, [
      BUNDLE_OWNERS,
    ]);

    expect(findings).toEqual([
      {
        reference: BUNDLE_OWNERS,
        rows: 2,
        distinctValues: 1,
        sampleIds: [ABSENT_OWNER],
      },
    ]);
  });

  it("refuses a declaration the database cannot answer", async () => {
    await expect(
      checkCrossDomainReferences(postgres.pool, [
        { ...DOCUMENT_OWNER, consumerColumn: "owner_id_renamed_away" },
      ]),
    ).rejects.toThrow(/could not be checked/);
  });
});

async function seedDocument(
  postgres: TestPostgres,
  row: {
    readonly ownerId?: string | null;
    readonly subjectId?: string;
    readonly subjectKind?: string;
  },
): Promise<void> {
  await postgres.pool.query(
    `INSERT INTO reference_check_documents (owner_id, subject_id, subject_kind)
     VALUES ($1, $2, $3)`,
    [row.ownerId ?? null, row.subjectId ?? null, row.subjectKind ?? null],
  );
}

async function seedSetMember(
  postgres: TestPostgres,
  scope: string,
  memberId: string,
): Promise<void> {
  const setId = deterministicUuid(`set-${scope}`, 1);
  await postgres.pool.query(
    `INSERT INTO reference_check_sets (id, scope_type) VALUES ($1, $2)`,
    [setId, scope],
  );
  await postgres.pool.query(
    `INSERT INTO reference_check_set_members (set_id, member_id) VALUES ($1, $2)`,
    [setId, memberId],
  );
}
