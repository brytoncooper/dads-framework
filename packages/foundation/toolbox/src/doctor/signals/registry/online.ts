/**
 * The three signals whose answer is not in the repository.
 *
 * They run last, and they are the only ones that can be switched off from the
 * command line, because they are the only ones that depend on somebody else
 * being up. Without `--online` each of them says `not measured (offline)` and
 * the report is otherwise identical, which is what makes a doctor run on a
 * plane the same document as a doctor run at a desk.
 *
 * Two of them ask a forge about this repository and one asks a registry about
 * its dependencies. All three read and nothing else: no request carries a
 * credential, none is retried, and no field is used that is not named in the
 * signal that reads it.
 *
 * They are ordered the way the report prints: the issues in `DAD.md` order.
 */

import type { DoctorSignal } from "../../doctor-signal.js";
import { ciDurationTrendSignal } from "../dad-has-issues-too/ci-duration-trend.js";
import { branchProtectionOffSignal } from "../its-not-you-its-my-boundaries/branch-protection-off.js";
import { unmaintainedDependenciesSignal } from "../you-stay-with-people-who-cannot-meet-you/unmaintained-dependencies.js";

/** The three readings that need a network. */
export const ONLINE_SIGNALS: readonly DoctorSignal[] = [
  unmaintainedDependenciesSignal,
  branchProtectionOffSignal,
  ciDurationTrendSignal,
];
