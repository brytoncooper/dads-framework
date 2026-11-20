import * as React from "react";

import {
  INITIAL_FIND_BAR_STATE,
  buildFindCommand,
  findCounter,
  findResultTone,
  type FindAction,
  type FindBarState,
  type FindCounter,
  type FindMatchCount,
  type FindResultTone,
} from "../logic/pdf-find.js";
import type { PdfEventBus } from "./pdf-types.js";

/**
 * How long a keystroke waits before it becomes a search, so the worker is not
 * handed a query per keystroke while someone is still typing.
 */
const FIND_INPUT_DEBOUNCE_MS = 250;

type FindControlStatePayload = {
  readonly state: number;
  readonly matchesCount?: FindMatchCount;
};
type FindMatchesCountPayload = {
  readonly matchesCount?: FindMatchCount;
};

const NO_MATCHES: FindMatchCount = { current: 0, total: 0 };

export type PdfFindState = {
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly entireWord: boolean;
  readonly highlightAll: boolean;
  readonly tone: FindResultTone;
  readonly counter: FindCounter;
  setQuery: (query: string) => void;
  toggleCaseSensitive: () => void;
  toggleEntireWord: () => void;
  toggleHighlightAll: () => void;
  findNext: () => void;
  findPrevious: () => void;
};

/**
 * The find bar's wire to pdf.js. It sends a `find` request whenever a control
 * is touched and listens for pdf.js's answers to keep the counter current.
 * The settings are read from a ref so a toggle can send its new value in the
 * same tick it sets it. When the bar unmounts, `findbarclose` clears the
 * highlights the search left behind.
 */
export function usePdfFind(eventBus: PdfEventBus): PdfFindState {
  const [barState, setBarState] = React.useState<FindBarState>(
    INITIAL_FIND_BAR_STATE,
  );
  const [resultCode, setResultCode] = React.useState<number | null>(null);
  const [matchCount, setMatchCount] =
    React.useState<FindMatchCount>(NO_MATCHES);
  const stateRef = React.useRef(barState);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const dispatchFind = React.useCallback(
    (next: FindBarState, action: FindAction) => {
      eventBus.dispatch("find", {
        source: null,
        ...buildFindCommand(next, action),
      });
    },
    [eventBus],
  );

  React.useEffect(() => {
    const onControlState = (event: FindControlStatePayload) => {
      setResultCode(event.state);
      setMatchCount(event.matchesCount ?? NO_MATCHES);
    };
    const onMatchesCount = (event: FindMatchesCountPayload) => {
      setMatchCount(event.matchesCount ?? NO_MATCHES);
    };
    eventBus.on("updatefindcontrolstate", onControlState);
    eventBus.on("updatefindmatchescount", onMatchesCount);
    return () => {
      eventBus.off("updatefindcontrolstate", onControlState);
      eventBus.off("updatefindmatchescount", onMatchesCount);
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      eventBus.dispatch("findbarclose", { source: null });
    };
  }, [eventBus]);

  const update = React.useCallback(
    (change: Partial<FindBarState>): FindBarState => {
      const next = { ...stateRef.current, ...change };
      stateRef.current = next;
      setBarState(next);
      return next;
    },
    [],
  );

  const setQuery = React.useCallback(
    (query: string) => {
      const next = update({ query });
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        dispatchFind(next, "search");
      }, FIND_INPUT_DEBOUNCE_MS);
    },
    [dispatchFind, update],
  );

  const toggleCaseSensitive = React.useCallback(() => {
    const next = update({ caseSensitive: !stateRef.current.caseSensitive });
    dispatchFind(next, "case-sensitive");
  }, [dispatchFind, update]);

  const toggleEntireWord = React.useCallback(() => {
    const next = update({ entireWord: !stateRef.current.entireWord });
    dispatchFind(next, "entire-word");
  }, [dispatchFind, update]);

  const toggleHighlightAll = React.useCallback(() => {
    const next = update({ highlightAll: !stateRef.current.highlightAll });
    dispatchFind(next, "highlight-all");
  }, [dispatchFind, update]);

  const findNext = React.useCallback(() => {
    dispatchFind(stateRef.current, "next");
  }, [dispatchFind]);
  const findPrevious = React.useCallback(() => {
    dispatchFind(stateRef.current, "previous");
  }, [dispatchFind]);

  const tone = findResultTone(resultCode, barState.query);

  return {
    query: barState.query,
    caseSensitive: barState.caseSensitive,
    entireWord: barState.entireWord,
    highlightAll: barState.highlightAll,
    tone,
    counter: findCounter(tone, matchCount),
    setQuery,
    toggleCaseSensitive,
    toggleEntireWord,
    toggleHighlightAll,
    findNext,
    findPrevious,
  };
}
