/**
 * The signals that read a built TypeScript program.
 *
 * This file belongs to the lane adding the TypeScript readings, so that lane
 * appends here rather than into the registry another lane is holding open.
 * Every signal below reads `context.program()` — the workspace's modules,
 * parsed once by the compiler — and so every one of them reports `not
 * measured` on a repository that declares no TypeScript project at all.
 *
 * The order is the order the report prints: the issues in `DAD.md` order, and
 * within an issue the order the companion asks its numbered questions.
 */

import type { DoctorSignal } from "../../doctor-signal.js";
import { copiedTypesSignal } from "../anxious-attachment/copied-types.js";
import { vendorTypesInSurfaceSignal } from "../anxious-attachment/vendor-types-in-surface.js";
import { undocumentedExportsSignal } from "../avoidant-attachment/undocumented-exports.js";
import { singleImplementerAbstractionsSignal } from "../commitment-issues/single-implementer-abstractions.js";
import { skippedTestsSignal } from "../commitment-issues/skipped-tests.js";
import { explicitAnySignal } from "../daddy-issues/explicit-any.js";
import { nonNullAssertionsSignal } from "../daddy-issues/non-null-assertions.js";
import { typeAssertionsSignal } from "../daddy-issues/type-assertions.js";
import { assertionsInTestsSignal } from "../disorganized-attachment/assertions-in-tests.js";
import { duplicateWireSchemasSignal } from "../disorganized-attachment/duplicate-wire-schemas.js";
import { interfaceTypeMixSignal } from "../disorganized-attachment/interface-type-mix.js";
import { unparsedBoundaryReadsSignal } from "../disorganized-attachment/unparsed-boundary-reads.js";
import { fanOutSignal } from "../enmeshment/fan-out.js";
import { functionsOverCeilingSignal } from "../enmeshment/functions-over-ceiling.js";
import { godClassesSignal } from "../enmeshment/god-classes.js";
import { intraPackageCyclesSignal } from "../enmeshment/intra-package-cycles.js";
import { strictProfileAbsentSignal } from "../failure-to-launch/strict-profile-absent.js";
import { deprecatedStillConsumedSignal } from "../people-pleasing/deprecated-still-consumed.js";
import { multiShapeResponsesSignal } from "../people-pleasing/multi-shape-responses.js";
import { optionalCreepSignal } from "../people-pleasing/optional-creep.js";
import { noInMemoryProviderSignal } from "../the-paper-wall/no-in-memory-provider.js";
import { providerChosenOutsideRootSignal } from "../the-paper-wall/provider-chosen-outside-root.js";
import { vendorNamedDomainSignal } from "../you-are-looking-for-a-father-figure/vendor-named-domain.js";
import { consoleInProductionSignal } from "../you-repeat-the-cycle/console-in-production.js";
import { domainInAppsSignal } from "../you-repeat-the-cycle/domain-in-apps.js";
import { perFeatureAuthorizationSignal } from "../you-repeat-the-cycle/per-feature-authorization.js";
import { roleIfLaddersSignal } from "../you-repeat-the-cycle/role-if-ladders.js";
import { tenantColumnAuthorizationSignal } from "../you-repeat-the-cycle/tenant-column-authorization.js";

/** The twenty-eight signals that read the parsed workspace. */
export const TYPESCRIPT_SIGNALS: readonly DoctorSignal[] = [
  explicitAnySignal,
  typeAssertionsSignal,
  nonNullAssertionsSignal,
  vendorTypesInSurfaceSignal,
  copiedTypesSignal,
  undocumentedExportsSignal,
  interfaceTypeMixSignal,
  unparsedBoundaryReadsSignal,
  duplicateWireSchemasSignal,
  assertionsInTestsSignal,
  vendorNamedDomainSignal,
  tenantColumnAuthorizationSignal,
  roleIfLaddersSignal,
  perFeatureAuthorizationSignal,
  consoleInProductionSignal,
  domainInAppsSignal,
  multiShapeResponsesSignal,
  optionalCreepSignal,
  deprecatedStillConsumedSignal,
  singleImplementerAbstractionsSignal,
  skippedTestsSignal,
  strictProfileAbsentSignal,
  functionsOverCeilingSignal,
  godClassesSignal,
  fanOutSignal,
  intraPackageCyclesSignal,
  noInMemoryProviderSignal,
  providerChosenOutsideRootSignal,
];
