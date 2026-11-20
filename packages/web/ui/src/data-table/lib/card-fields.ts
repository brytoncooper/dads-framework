import { ACTIONS_COLUMN_ID, isSelectionColumnId } from "./column-roles.js";

/** How many label/value pairs a phone card shows before its details. */
export const CARD_SUMMARY_LIMIT = 3;

/** One column a card holds, as the card layout needs to know it. */
export type CardColumn = {
  readonly id: string;
  readonly cardHeading?: boolean;
  /** `meta.cardSummary`: true puts it in the summary, false keeps it in the details. */
  readonly cardSummary?: boolean;
  /** Hidden by the reader on wide screens: still on the card, only in the details. */
  readonly readerHidden?: boolean;
};

/**
 * Where each column goes on a phone card. Every column given lands in exactly
 * one place, so collapsing a row into a card never drops a field.
 */
export type CardFieldPlan = {
  readonly selectionId: string | undefined;
  readonly headingId: string | undefined;
  readonly summaryIds: readonly string[];
  readonly detailIds: readonly string[];
  readonly actionsId: string | undefined;
};

/**
 * Lay a card's columns out: the identifying column as the heading, up to
 * three summary fields, every remaining column in the details, and
 * the actions in the footer.
 *
 * Summary fields are the columns that opt in with `cardSummary: true` when any
 * do; otherwise the next columns, skipping those that opt out. A column the
 * reader hid is never a summary field; it waits in the details.
 */
export function planCardFields(columns: readonly CardColumn[]): CardFieldPlan {
  const selectionId = columns.find((column) =>
    isSelectionColumnId(column.id),
  )?.id;
  const actionsId = columns.find(
    (column) => column.id === ACTIONS_COLUMN_ID,
  )?.id;
  const content = columns.filter(
    (column) =>
      !isSelectionColumnId(column.id) && column.id !== ACTIONS_COLUMN_ID,
  );
  const heading =
    content.find((column) => column.cardHeading === true) ?? content[0];
  const fields = content.filter((column) => column !== heading);
  const shownFields = fields.filter((column) => column.readerHidden !== true);

  const optedIn = shownFields.filter((column) => column.cardSummary === true);
  const summaryCandidates =
    optedIn.length > 0
      ? optedIn
      : shownFields.filter((column) => column.cardSummary !== false);
  const summaryIds = summaryCandidates
    .slice(0, CARD_SUMMARY_LIMIT)
    .map((column) => column.id);
  const summarySet = new Set(summaryIds);
  const detailIds = fields
    .filter((column) => !summarySet.has(column.id))
    .map((column) => column.id);

  return {
    selectionId,
    headingId: heading?.id,
    summaryIds,
    detailIds,
    actionsId,
  };
}
