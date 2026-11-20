/**
 * The signals that hold what a repository stores and what it sends: its
 * migrations, the files generated from them and from its access declarations,
 * the proofs those declarations owe, the shapes on the wire, and the words on
 * a screen.
 *
 * They arrived together, ported as one set from walls an application already
 * ran on itself, and re-expressed against what any repository can show:
 * banners and history rather than one tree's folder names. Five read history,
 * one reads packages, and the rest read the TypeScript program.
 *
 * The order is the order the report prints: the issues in `DAD.md` order, and
 * within an issue the order the companion asks its numbered questions.
 */

import type { DoctorSignal } from "../../doctor-signal.js";
import { accessWithoutDenialTestSignal } from "../commitment-issues/access-without-denial-test.js";
import { sequentialAuthzWritesSignal } from "../commitment-issues/sequential-authz-writes.js";
import { jsonbWithoutSchemaSignal } from "../disorganized-attachment/jsonb-without-schema.js";
import { migrationsOutOfOrderSignal } from "../disorganized-attachment/migrations-out-of-order.js";
import { generatedAccessHandEditedSignal } from "../gaslighting/generated-access-hand-edited.js";
import { generatedTablesHandEditedSignal } from "../gaslighting/generated-tables-hand-edited.js";
import { migrationsEditedSignal } from "../gaslighting/migrations-edited.js";
import { rowsSentWholeSignal } from "../its-not-you-its-my-boundaries/rows-sent-whole.js";
import { looseContractObjectsSignal } from "../people-pleasing/loose-contract-objects.js";
import { rawErrorsInUiSignal } from "../people-pleasing/raw-errors-in-ui.js";
import { hardcodedUiCopySignal } from "../you-are-looking-for-a-father-figure/hardcoded-ui-copy.js";

/** The eleven readings this lane added, in `DAD.md` order. */
export const STORED_AND_SENT_SIGNALS: readonly DoctorSignal[] = [
  jsonbWithoutSchemaSignal,
  migrationsOutOfOrderSignal,
  hardcodedUiCopySignal,
  looseContractObjectsSignal,
  rawErrorsInUiSignal,
  accessWithoutDenialTestSignal,
  sequentialAuthzWritesSignal,
  migrationsEditedSignal,
  generatedTablesHandEditedSignal,
  generatedAccessHandEditedSignal,
  rowsSentWholeSignal,
];
