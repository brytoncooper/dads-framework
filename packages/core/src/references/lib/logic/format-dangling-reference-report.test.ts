import { describe, expect, it } from "vitest";
import type {
  CrossDomainReference,
  DanglingReferenceFinding,
} from "../cross-domain-reference.js";
import {
  formatCleanReport,
  formatDanglingReferenceReport,
} from "./format-dangling-reference-report.js";

const OWNER_ORGANIZATION: CrossDomainReference = {
  id: "facilities.owner_organization_id",
  consumerDomain: "facilities",
  consumerTable: "facilities",
  consumerColumn: "owner_organization_id",
  providerDomain: "organizations",
  providerTable: "organizations",
  providerColumn: "id",
  classification: "live-association",
};

const ACTOR_USER: CrossDomainReference = {
  id: "support_session_events.actor_user_id",
  consumerDomain: "platform-staff",
  consumerTable: "support_session_events",
  consumerColumn: "actor_user_id",
  providerDomain: "identity",
  providerTable: "user",
  providerColumn: "id",
  classification: "historical-document",
};

function finding(
  reference: CrossDomainReference,
  rows: number,
): DanglingReferenceFinding {
  return { reference, rows, distinctValues: 1, sampleIds: ["id-1"] };
}

describe("formatCleanReport", () => {
  it("says how many references ran, so a clean run is not silence", () => {
    expect(formatCleanReport(85)).toContain("85 references checked");
  });
});

describe("formatDanglingReferenceReport", () => {
  it("names table, column, target, count, and sample ids", () => {
    const report = formatDanglingReferenceReport(
      [
        {
          reference: OWNER_ORGANIZATION,
          rows: 3,
          distinctValues: 2,
          sampleIds: ["id-1", "id-2"],
        },
      ],
      85,
    );

    expect(report).toContain(
      "facilities.owner_organization_id → organizations.id",
    );
    expect(report).toContain("3 rows, 2 distinct ids, live-association");
    expect(report).toContain("sample ids: id-1, id-2");
  });

  it("counts in English, so a single finding does not read `1 rows`", () => {
    const report = formatDanglingReferenceReport([finding(ACTOR_USER, 1)], 85);

    expect(report).toContain("1 row, 1 distinct id, historical-document");
  });

  /**
   * ADR-0023 repairs a live association and never rewrites a document, so the
   * class has to survive into the report an operator acts on.
   */
  it("carries each finding's classification", () => {
    const report = formatDanglingReferenceReport([finding(ACTOR_USER, 1)], 85);

    expect(report).toContain("historical-document");
  });

  it("puts the worst finding first", () => {
    const report = formatDanglingReferenceReport(
      [finding(ACTOR_USER, 2), finding(OWNER_ORGANIZATION, 9)],
      85,
    );

    expect(report.indexOf("facilities.owner_organization_id")).toBeLessThan(
      report.indexOf("support_session_events.actor_user_id"),
    );
  });

  it("totals broken references and dangling rows in the header", () => {
    const report = formatDanglingReferenceReport(
      [finding(ACTOR_USER, 2), finding(OWNER_ORGANIZATION, 9)],
      85,
    );

    expect(report.split("\n")[0]).toBe(
      "cross-domain reference integrity: 85 references checked, 2 broken, 11 dangling rows",
    );
  });
});
