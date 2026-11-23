import type { DndContextProps, UniqueIdentifier } from "@dnd-kit/core";
import type { SortableContextProps } from "@dnd-kit/sortable";
import * as React from "react";

const ROOT_NAME = "Sortable";

// Row-type free on purpose: the descendants read positions and presentation
// only, so the context does not have to be generic over the item type.
export type SortableRootContextValue = {
  id: string;
  items: UniqueIdentifier[];
  modifiers: DndContextProps["modifiers"];
  strategy: SortableContextProps["strategy"];
  activeId: UniqueIdentifier | null;
  setActiveId: (id: UniqueIdentifier | null) => void;
  flatCursor: boolean;
};

export const SortableRootContext = React.createContext<SortableRootContextValue | null>(null);

export function useSortableContext(consumerName: string) {
  const context = React.useContext(SortableRootContext);
  if (!context) {
    throw new Error(`\`${consumerName}\` must be used within \`${ROOT_NAME}\``);
  }
  return context;
}
