/**
 * Public surface of the cross-domain reference kit: the
 * vocabulary a domain declares its loose references in, the engine that LEFT
 * JOINs them against a real database, and the report an operator reads.
 *
 * The live-environment action that runs the check is declared by the product,
 * not here: the live-environment-actions kit declares a loose reference of its
 * own, so it imports this kit, and an action defined here would close a cycle.
 */
export type {
  CrossDomainBrandOwner,
  CrossDomainReference,
  DanglingReferenceFinding,
  ParentDiscriminator,
  ReferenceClassification,
  ReferenceFilter,
} from "./lib/cross-domain-reference.js";
export { SAMPLE_LIMIT } from "./lib/cross-domain-reference.js";
export {
  assembleCrossDomainReferences,
  declareCrossDomainBrandOwners,
  declareCrossDomainReferences,
} from "./lib/declare-cross-domain-references.js";
export {
  buildDanglingValueQuery,
  checkCrossDomainReferences,
  type CrossDomainReferenceQueryClient,
} from "./lib/database/check-cross-domain-references.js";
export { formatCleanReport, formatDanglingReferenceReport } from "./lib/logic/format-dangling-reference-report.js";
export {
  CheckCrossDomainReferences,
  type CheckCrossDomainReferencesDependencies,
  type CrossDomainReferenceCheckReport,
} from "./lib/queries/check-cross-domain-references.query.js";
