import {
  type Announcements,
  closestCenter,
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  type ScreenReaderInstructions,
  TouchSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import * as React from "react";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import type { SortableComponent, SortableRuntimeProps, SortableProps } from "./sortable-types.js";

import { SortableRootContext, type SortableRootContextValue } from "./sortable-root-context.js";

const orientationConfig = {
  vertical: {
    modifiers: [restrictToVerticalAxis, restrictToParentElement],
    strategy: verticalListSortingStrategy,
    collisionDetection: closestCenter,
  },
  horizontal: {
    modifiers: [restrictToHorizontalAxis, restrictToParentElement],
    strategy: horizontalListSortingStrategy,
    collisionDetection: closestCenter,
  },
  mixed: {
    modifiers: [restrictToParentElement],
    strategy: undefined,
    collisionDetection: closestCorners,
  },
};

/**
 * A consumer opts out of the wrapper's own bookkeeping by calling
 * `preventDefault()` on the activator event from its `onDrag*` prop. dnd-kit's
 * KeyboardSensor already calls `preventDefault()` on the Space/Enter keydown
 * that activates a drag, so for keyboard activators `defaultPrevented` carries
 * no consumer signal; reading it would skip every keyboard drop.
 */
function isOptedOutByConsumer(activatorEvent: Event): boolean {
  if (activatorEvent instanceof KeyboardEvent) return false;
  return activatorEvent.defaultPrevented;
}

const Sortable: SortableComponent = <T,>(props: SortableRuntimeProps<T>) => {
  const t = useDataTableCopy();
  const {
    value,
    onValueChange,
    collisionDetection,
    modifiers,
    strategy,
    onMove,
    orientation = "vertical",
    flatCursor = false,
    getItemValue: getItemValueProp,
    accessibility,
    ...sortableProps
  } = props;

  const id = React.useId();
  const [activeId, setActiveId] = React.useState<UniqueIdentifier | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const config = React.useMemo(() => orientationConfig[orientation], [orientation]);
  type SortableValue = (typeof value)[number];

  const getItemValue = React.useCallback(
    (item: SortableValue): UniqueIdentifier => {
      if (getItemValueProp) return getItemValueProp(item);
      if (typeof item === "string" || typeof item === "number") return item;

      throw new Error("`getItemValue` is required when using an array of objects");
    },
    [getItemValueProp],
  );

  const items = React.useMemo(() => {
    return value.map((item) => getItemValue(item));
  }, [value, getItemValue]);

  function onDragStart(event: DragStartEvent): void {
    sortableProps.onDragStart?.(event);

    if (isOptedOutByConsumer(event.activatorEvent)) return;

    setActiveId(event.active.id);
  }

  function onDragEnd(event: DragEndEvent): void {
    sortableProps.onDragEnd?.(event);

    if (isOptedOutByConsumer(event.activatorEvent)) return;

    const { active, over } = event;
    if (over && active.id !== over.id) {
      const activeIndex = value.findIndex((item) => getItemValue(item) === active.id);
      const overIndex = value.findIndex((item) => getItemValue(item) === over.id);

      if (onMove) {
        onMove({ ...event, activeIndex, overIndex });
      } else {
        onValueChange?.(arrayMove(value, activeIndex, overIndex));
      }
    }
    setActiveId(null);
  }

  function onDragCancel(event: DragEndEvent): void {
    sortableProps.onDragCancel?.(event);

    if (isOptedOutByConsumer(event.activatorEvent)) return;

    setActiveId(null);
  }

  // Positions come from `items` rather than dnd-kit's untyped `data.current`
  // blob: same numbers, no `any` crossing into the announcement text.
  const announcements: Announcements = React.useMemo(() => {
    const positionOf = (id: UniqueIdentifier) => items.indexOf(id) + 1;
    const total = items.length;

    return {
      onDragStart({ active }) {
        return t("dataTable.sortable.grabbed", {
          itemId: active.id.toString(),
          position: positionOf(active.id),
          total,
        });
      },
      onDragOver({ active, over }) {
        if (!over) return t("dataTable.sortable.notOverDroppable");

        const movementKey =
          positionOf(over.id) > positionOf(active.id) ? "dataTable.sortable.movedDown" : "dataTable.sortable.movedUp";
        return t(movementKey, {
          itemId: active.id.toString(),
          position: positionOf(over.id),
          total,
        });
      },
      onDragEnd({ active, over }) {
        if (!over) {
          return t("dataTable.sortable.droppedWithoutChanges", {
            itemId: active.id.toString(),
          });
        }
        return t("dataTable.sortable.droppedAtPosition", {
          itemId: active.id.toString(),
          position: positionOf(over.id),
          total,
        });
      },
      onDragCancel({ active }) {
        return t("dataTable.sortable.cancelled", {
          itemId: active.id.toString(),
          position: positionOf(active.id),
          total,
        });
      },
      onDragMove({ active, over }) {
        if (!over) return t("dataTable.sortable.notOverDroppable");

        const movementKey =
          positionOf(over.id) > positionOf(active.id) ? "dataTable.sortable.movingDown" : "dataTable.sortable.movingUp";
        return t(movementKey, {
          itemId: active.id.toString(),
          position: positionOf(over.id),
          total,
        });
      },
    };
  }, [items, t]);

  const screenReaderInstructions: ScreenReaderInstructions = React.useMemo(() => {
    const instructionsKey =
      orientation === "vertical"
        ? "dataTable.sortable.instructions.vertical"
        : orientation === "horizontal"
          ? "dataTable.sortable.instructions.horizontal"
          : "dataTable.sortable.instructions.mixed";

    return { draggable: t(instructionsKey) };
  }, [orientation, t]);

  const contextValue = React.useMemo<SortableRootContextValue>(
    () => ({
      id,
      items,
      modifiers: modifiers ?? config.modifiers,
      strategy: strategy ?? config.strategy,
      activeId,
      setActiveId,
      flatCursor,
    }),
    [id, items, modifiers, strategy, config.modifiers, config.strategy, activeId, flatCursor],
  );

  return (
    <SortableRootContext.Provider value={contextValue}>
      <DndContext
        collisionDetection={collisionDetection ?? config.collisionDetection}
        modifiers={modifiers ?? config.modifiers}
        sensors={sensors}
        {...sortableProps}
        id={id}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{
          announcements,
          screenReaderInstructions,
          ...accessibility,
        }}
      />
    </SortableRootContext.Provider>
  );
};

export { Sortable, type SortableProps };
export { SortableContent, SortableItem, SortableItemHandle, SortableOverlay } from "./sortable-parts.js";
