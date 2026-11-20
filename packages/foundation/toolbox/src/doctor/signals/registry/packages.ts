/**
 * The signals that read the package graph: declarations, manifests, imports.
 *
 * This file belongs to the packages-and-routes lane, so that lane appends here
 * rather than into the registry another lane is holding open. `kind-inversions`
 * is not here: phase zero shipped it, and it stays in the foundation registry
 * where it landed. `provider-chosen-outside-root` is not here either: the
 * catalog gives it the program to read, and it is registered by the lane that
 * builds one.
 *
 * The order is the order the report prints — the issues in `DAD.md` order, and
 * within an issue the order the companion asks its numbered questions.
 */

import type { DoctorSignal } from "../../doctor-signal.js";
import { blastRadiusSignal } from "../anxious-attachment/blast-radius.js";
import { vendorOutsideAdapterSignal } from "../anxious-attachment/vendor-outside-adapter.js";
import { kindsUndeclaredSignal } from "../its-not-you-its-my-boundaries/kinds-undeclared.js";
import { wrapperWithoutConformanceSignal } from "../the-paper-wall/wrapper-without-conformance.js";
import { frameworkInCoreSignal } from "../you-are-looking-for-a-father-figure/framework-in-core.js";
import { orphanPathsSignal } from "../you-let-the-babysitter-raise-them/orphan-paths.js";
import { controllingPeersSignal } from "../you-stay-with-people-who-cannot-meet-you/controlling-peers.js";
import { sharedCatchallSignal } from "../you-stay-with-people-who-cannot-meet-you/shared-catchall.js";
import { sharedDatabaseSignal } from "../you-stay-with-people-who-cannot-meet-you/shared-database.js";
import { transportAtRootSignal } from "../you-stay-with-people-who-cannot-meet-you/transport-at-root.js";

/** The ten readings the package graph answers. */
export const PACKAGE_SIGNALS: readonly DoctorSignal[] = [
  vendorOutsideAdapterSignal,
  blastRadiusSignal,
  frameworkInCoreSignal,
  controllingPeersSignal,
  transportAtRootSignal,
  sharedDatabaseSignal,
  sharedCatchallSignal,
  kindsUndeclaredSignal,
  orphanPathsSignal,
  wrapperWithoutConformanceSignal,
];
