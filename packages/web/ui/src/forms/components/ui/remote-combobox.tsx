"use client";

import * as React from "react";
import {
  nextRemoteComboboxItems,
  pageHasMore,
  shouldPrefetchNextPage,
  type LoadRemoteComboboxPage,
} from "../../logic/remote-combobox-page.js";
import { Combobox } from "./combobox.js";
import { RemoteComboboxContext } from "./remote-combobox-context.js";

function itemValueKey(item: unknown): string | number {
  if (typeof item === "string" || typeof item === "number") return item;
  if (typeof item === "object" && item !== null && "value" in item) {
    const key: unknown = item.value;
    if (typeof key === "string" || typeof key === "number") return key;
  }
  return String(item);
}

type RemoteComboboxShared<Item> = {
  readonly loadPage: LoadRemoteComboboxPage<Item>;
  readonly itemKey?: (item: Item) => string | number;
  readonly enabled?: boolean;
  readonly debounceMs?: number;
  readonly disabled?: boolean;
  readonly children: React.ReactNode;
  readonly getKey?: (item: Item) => string | number | null | undefined;
  /** Opens the list on mount, for a picker the person just asked for. */
  readonly defaultOpen?: boolean;
};

type RemoteComboboxSingleProps<Item> = RemoteComboboxShared<Item> & {
  readonly multiple?: false;
  readonly value: Item | null;
  readonly onValueChange: (next: Item | null) => void;
};

type RemoteComboboxMultipleProps<Item> = RemoteComboboxShared<Item> & {
  readonly multiple: true;
  readonly value: Item[];
  readonly onValueChange: (next: Item[]) => void;
};

type RemoteComboboxProps<Item> = RemoteComboboxSingleProps<Item> | RemoteComboboxMultipleProps<Item>;

/**
 * A combobox whose options come from the server as the person types and
 * scrolls.
 *
 * `loadPage` is required. The kit calls it with the settled search term and
 * the next page; it does not filter a page the caller already fetched. Static
 * lists stay on `Combobox`. Multi-select keeps the typed term so the next
 * pick is still against that search.
 */
function RemoteCombobox<Item>(props: RemoteComboboxProps<Item>): React.JSX.Element {
  const itemKey = props.itemKey ?? itemValueKey;
  const remote = useRemoteComboboxList({
    loadPage: props.loadPage,
    itemKey,
    enabled: (props.enabled ?? true) && props.disabled !== true,
    debounceMs: props.debounceMs ?? 200,
  });
  const multiple = props.multiple === true;

  return (
    <RemoteComboboxContext.Provider value={remote}>
      {multiple ? (
        <Combobox
          multiple
          items={remote.items}
          filteredItems={remote.items}
          filter={null}
          inputValue={remote.query}
          onInputValueChange={(next, eventDetails) => {
            if (eventDetails.reason === "input-clear") {
              eventDetails.cancel();
              return;
            }
            remote.setQuery(next);
          }}
          value={props.value}
          disabled={props.disabled}
          {...(props.getKey === undefined ? {} : { getKey: props.getKey })}
          defaultOpen={props.defaultOpen}
          onValueChange={props.onValueChange}
        >
          {props.children}
        </Combobox>
      ) : (
        <Combobox
          items={remote.items}
          filteredItems={remote.items}
          filter={null}
          inputValue={remote.query}
          onInputValueChange={(next) => {
            remote.setQuery(next);
          }}
          value={props.value}
          disabled={props.disabled}
          {...(props.getKey === undefined ? {} : { getKey: props.getKey })}
          defaultOpen={props.defaultOpen}
          onValueChange={(next) => {
            remote.setQuery("");
            props.onValueChange(next);
          }}
        >
          {props.children}
        </Combobox>
      )}
    </RemoteComboboxContext.Provider>
  );
}

function useRemoteComboboxList<Item>({
  loadPage,
  itemKey,
  enabled,
  debounceMs,
}: {
  loadPage: LoadRemoteComboboxPage<Item>;
  itemKey: (item: Item) => string | number;
  enabled: boolean;
  debounceMs: number;
}) {
  const [query, setQuery] = React.useState("");
  const [settledQuery, setSettledQuery] = React.useState("");
  const [items, setItems] = React.useState<readonly Item[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const loadingRef = React.useRef(false);
  const pageRef = React.useRef(1);
  const itemsRef = React.useRef<readonly Item[]>([]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettledQuery(query);
    }, debounceMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, debounceMs]);

  React.useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    loadingRef.current = true;
    itemsRef.current = [];
    pageRef.current = 1;
    setItems([]);
    void loadPage({
      query: settledQuery,
      page: 1,
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        itemsRef.current = result.items;
        setItems(result.items);
        setHasMore(result.hasMore);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
      })
      .finally(() => {
        loadingRef.current = false;
      });
    return () => {
      controller.abort();
    };
  }, [enabled, loadPage, settledQuery]);

  const prefetchNext = React.useCallback(() => {
    if (
      !enabled ||
      !shouldPrefetchNextPage({
        hasMore,
        loading: loadingRef.current,
      })
    ) {
      return;
    }
    const nextPage = pageRef.current + 1;
    loadingRef.current = true;
    const controller = new AbortController();
    void loadPage({
      query: settledQuery,
      page: nextPage,
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const merged = nextRemoteComboboxItems({
          current: itemsRef.current,
          incoming: result.items,
          page: nextPage,
          itemKey,
        });
        itemsRef.current = merged;
        pageRef.current = nextPage;
        setItems(merged);
        setHasMore(result.hasMore);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
      })
      .finally(() => {
        loadingRef.current = false;
      });
  }, [enabled, hasMore, itemKey, loadPage, settledQuery]);

  return {
    query,
    setQuery,
    items,
    prefetchNext,
  };
}

export { pageHasMore, RemoteCombobox };
export type { LoadRemoteComboboxPage };
