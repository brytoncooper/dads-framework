import type {
  DndContextProps,
  DragEndEvent,
  UniqueIdentifier,
} from "@dnd-kit/core";
import type { SortableContextProps } from "@dnd-kit/sortable";
import type { ReactNode } from "react";

type GetItemValue<T> = {
  /**
   * Returns a unique identifier for each sortable item. Required whenever the
   * items are objects — for example, reading each item's own id.
   */
  getItemValue: (item: T) => UniqueIdentifier;
};

// List the drag context options accepted by the sort controls so new vendor
// options do not automatically become part of this component's props.
type DragContextOptions = Pick<
  DndContextProps,
  | "id"
  | "accessibility"
  | "autoScroll"
  | "cancelDrop"
  | "children"
  | "collisionDetection"
  | "measuring"
  | "modifiers"
  | "sensors"
  | "onDragAbort"
  | "onDragPending"
  | "onDragStart"
  | "onDragMove"
  | "onDragOver"
  | "onDragEnd"
  | "onDragCancel"
>;

export type SortableRuntimeProps<T> = DragContextOptions &
  Partial<GetItemValue<T>> & {
    value: T[];
    onValueChange?: (items: T[]) => void;
    onMove?: (
      event: DragEndEvent & { activeIndex: number; overIndex: number },
    ) => void;
    strategy?: NonNullable<SortableContextProps["strategy"]>;
    orientation?: "vertical" | "horizontal" | "mixed";
    flatCursor?: boolean;
  };

export type SortableProps<T> = SortableRuntimeProps<T> &
  (T extends object ? GetItemValue<T> : unknown);

/** The generic component signature kept separate from its JSX implementation. */
export type SortableComponent = <T>(props: SortableProps<T>) => ReactNode;
