import { ok, type Result } from "@dads-framework/errors";

import type { CrossDomainReference } from "../cross-domain-reference.js";
import {
  checkCrossDomainReferences,
  type CrossDomainReferenceQueryClient,
} from "../database/check-cross-domain-references.js";
import {
  formatCleanReport,
  formatDanglingReferenceReport,
} from "../logic/format-dangling-reference-report.js";

/** What one run of the check says, in the words the CLI prints. */
export type CrossDomainReferenceCheckReport = {
  /** How many declared references the run LEFT JOINed. */
  readonly checkedReferences: number;
  /** How many of them had at least one value matching nothing. */
  readonly danglingReferences: number;
  /** Referencing rows behind those broken references. */
  readonly danglingRows: number;
  /** The report an operator reads — identical to `npm run db:check-references`. */
  readonly report: string;
};

export type CheckCrossDomainReferencesDependencies = {
  readonly pool: CrossDomainReferenceQueryClient;
  /** This product's assembled declarations, from its composition root. */
  readonly references: readonly CrossDomainReference[];
};

/**
 * ADR-0023's detection wall, run on demand against a live environment.
 *
 * Read-only: it LEFT JOINs every declared reference to the key it claims to
 * point at and counts what matches nothing. Nothing is repaired here and
 * nothing is recorded — a finding is a report an owner acts on, which is the
 * policy ADR-0023 states for a dangling reference and the reason the same
 * engine serves the nightly CLI and this action.
 */
export class CheckCrossDomainReferences {
  constructor(
    private readonly dependencies: CheckCrossDomainReferencesDependencies,
  ) {}

  async execute(): Promise<Result<CrossDomainReferenceCheckReport>> {
    const { pool, references } = this.dependencies;
    const findings = await checkCrossDomainReferences(pool, references);
    const danglingRows = findings.reduce(
      (total, finding) => total + finding.rows,
      0,
    );

    return ok({
      checkedReferences: references.length,
      danglingReferences: findings.length,
      danglingRows,
      report:
        findings.length === 0
          ? formatCleanReport(references.length)
          : formatDanglingReferenceReport(findings, references.length),
    });
  }
}
