/**
 * The rules the Find in Document bar is driven by.
 *
 * pdf.js does the searching: its `PDFFindController` listens for a `find`
 * event on the viewer's event bus and answers with `updatefindcontrolstate`
 * and `updatefindmatchescount`. What is worth testing is the decision-making
 * that needs no pdf.js: which request each control sends, how pdf.js's result
 * code becomes something the bar can show, and what the match counter reads.
 */

/** The bar's own settings: the four things a reader can change. */
export type FindBarState = {
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly entireWord: boolean;
  readonly highlightAll: boolean;
};

/** A fresh bar: nothing typed, every match highlighted. */
export const INITIAL_FIND_BAR_STATE: FindBarState = {
  query: "",
  caseSensitive: false,
  entireWord: false,
  highlightAll: true,
};

/** The control a reader touched, named by intent rather than by pdf.js's event type. */
export type FindAction =
  | "search"
  | "next"
  | "previous"
  | "highlight-all"
  | "case-sensitive"
  | "entire-word";

/**
 * The `find` event payload pdf.js reads. An empty `type` starts a fresh
 * search, `again` steps to the next or previous match, and the `*change` types
 * re-run the current search with a toggled option.
 */
export type FindCommand = {
  readonly type: string;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly entireWord: boolean;
  readonly highlightAll: boolean;
  readonly findPrevious: boolean;
  readonly matchDiacritics: boolean;
};

const FIND_ACTION_TYPE: Readonly<Record<FindAction, string>> = {
  search: "",
  next: "again",
  previous: "again",
  "highlight-all": "highlightallchange",
  "case-sensitive": "casesensitivitychange",
  "entire-word": "entirewordchange",
};

/** Turns the bar's settings plus the touched control into a `find` request. */
export function buildFindCommand(
  state: FindBarState,
  action: FindAction,
): FindCommand {
  return {
    type: FIND_ACTION_TYPE[action],
    query: state.query,
    caseSensitive: state.caseSensitive,
    entireWord: state.entireWord,
    highlightAll: state.highlightAll,
    findPrevious: action === "previous",
    matchDiacritics: false,
  };
}

/** How the bar reads a result: nothing typed, still searching, a hit, or a miss. */
export type FindResultTone = "idle" | "pending" | "found" | "not-found";

/**
 * pdf.js's `FindState` codes, copied as numbers so this module needs no pdf.js
 * import. The hook passes the real code through and it is mapped here.
 */
const FIND_STATE_FOUND = 0;
const FIND_STATE_NOT_FOUND = 1;
const FIND_STATE_WRAPPED = 2;
const FIND_STATE_PENDING = 3;

/**
 * Turns pdf.js's result code into a tone. An empty query is always `idle`, so
 * clearing the box drops the not-found styling instead of stranding it.
 */
export function findResultTone(
  resultCode: number | null,
  query: string,
): FindResultTone {
  if (query.trim().length === 0) return "idle";
  switch (resultCode) {
    case FIND_STATE_PENDING:
      return "pending";
    case FIND_STATE_NOT_FOUND:
      return "not-found";
    case FIND_STATE_FOUND:
    case FIND_STATE_WRAPPED:
      return "found";
    case null:
    default:
      return "idle";
  }
}

/** The running "current match of total" count pdf.js reports. */
export type FindMatchCount = {
  readonly current: number;
  readonly total: number;
};

/** What the match counter shows; the bar turns it into localized text. */
export type FindCounter =
  | { readonly kind: "blank" }
  | { readonly kind: "no-matches" }
  | {
      readonly kind: "match";
      readonly current: number;
      readonly total: number;
    };

/**
 * The counter for a tone and count: blank while idle, "no matches" on a miss,
 * and "N of M" once there is at least one hit. It stays blank while a hit is
 * still being counted, so it never flashes a zero.
 */
export function findCounter(
  tone: FindResultTone,
  count: FindMatchCount,
): FindCounter {
  if (tone === "not-found") return { kind: "no-matches" };
  if (tone === "idle" || count.total <= 0) return { kind: "blank" };
  return { kind: "match", current: count.current, total: count.total };
}
