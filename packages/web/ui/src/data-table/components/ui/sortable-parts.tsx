import {
  defaultDropAnimationSideEffects,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  DragOverlay,
  type DropAnimation,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, type SortableContextProps, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Slot as SlotPrimitive } from "radix-ui";
import * as React from "react";
import * as ReactDOM from "react-dom";

import { cn } from "../../../elements/index.js";

import { useComposedRefs } from "../../lib/compose-refs.js";

import { useSortableContext } from "./sortable-root-context.js";

const CONTENT_NAME = "SortableContent";
const ITEM_NAME = "SortableItem";
const ITEM_HANDLE_NAME = "SortableItemHandle";
const OVERLAY_NAME = "SortableOverlay";

const SortableContentContext = React.createContext<boolean>(false);

type SortableContentProps = React.ComponentProps<"div"> & {
  strategy?: SortableContextProps["strategy"];
  children: React.ReactNode;
  asChild?: boolean;
  withoutSlot?: boolean;
};

function SortableContent(props: SortableContentProps) {
  const { strategy: strategyProp, asChild, withoutSlot, children, ref, ...contentProps } = props;

  const context = useSortableContext(CONTENT_NAME);

  const strategy = strategyProp ?? context.strategy;
  const ContentPrimitive = asChild ? SlotPrimitive.Slot : "div";

  return (
    <SortableContentContext.Provider value={true}>
      <SortableContext items={context.items} {...(strategy ? { strategy } : {})}>
        {withoutSlot ? (
          children
        ) : (
          <ContentPrimitive data-slot="sortable-content" {...contentProps} ref={ref}>
            {children}
          </ContentPrimitive>
        )}
      </SortableContext>
    </SortableContentContext.Provider>
  );
}

type SortableItemContextValue = {
  id: string;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners | undefined;
  setActivatorNodeRef: (node: HTMLElement | null) => void;
  isDragging?: boolean;
  disabled?: boolean;
};

const SortableItemContext = React.createContext<SortableItemContextValue | null>(null);

function useSortableItemContext(consumerName: string) {
  const context = React.useContext(SortableItemContext);
  if (!context) {
    throw new Error(`\`${consumerName}\` must be used within \`${ITEM_NAME}\``);
  }
  return context;
}

type SortableItemProps = React.ComponentProps<"div"> & {
  value: UniqueIdentifier;
  asHandle?: boolean;
  asChild?: boolean;
  disabled?: boolean;
};

function SortableItem(props: SortableItemProps) {
  const { value, style, asHandle, asChild, disabled, className, ref, ...itemProps } = props;

  useSortableItemPlacement(value);

  const context = useSortableContext(ITEM_NAME);
  const id = React.useId();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: value,
    ...(disabled === undefined ? {} : { disabled }),
  });

  const composedRef = useComposedRefs(ref, (node) => {
    if (disabled) return;
    setNodeRef(node);
    if (asHandle) setActivatorNodeRef(node);
  });

  const composedStyle = React.useMemo<React.CSSProperties>(() => {
    return {
      transform: CSS.Translate.toString(transform),
      transition,
      ...style,
    };
  }, [transform, transition, style]);

  const itemContext = React.useMemo<SortableItemContextValue>(
    () => ({
      id,
      attributes,
      listeners,
      setActivatorNodeRef,
      isDragging,
      ...(disabled === undefined ? {} : { disabled }),
    }),
    [id, attributes, listeners, setActivatorNodeRef, isDragging, disabled],
  );

  const handleEnabled = asHandle && !disabled;
  const ItemPrimitive = asChild ? SlotPrimitive.Slot : "div";

  return (
    <SortableItemContext.Provider value={itemContext}>
      <ItemPrimitive
        id={id}
        data-disabled={disabled}
        data-dragging={isDragging ? "" : undefined}
        data-slot="sortable-item"
        {...itemProps}
        {...(handleEnabled ? attributes : {})}
        {...(handleEnabled ? listeners : {})}
        ref={composedRef}
        style={composedStyle}
        className={sortableItemClassName(asHandle, context.flatCursor, isDragging, disabled, className)}
      />
    </SortableItemContext.Provider>
  );
}

type SortableItemHandleProps = React.ComponentProps<"button"> & {
  asChild?: boolean;
};

function SortableItemHandle(props: SortableItemHandleProps) {
  const { asChild, disabled, className, ref, ...itemHandleProps } = props;

  const context = useSortableContext(ITEM_HANDLE_NAME);
  const itemContext = useSortableItemContext(ITEM_HANDLE_NAME);

  const isDisabled = disabled ?? itemContext.disabled;

  const composedRef = useComposedRefs(ref, (node) => {
    if (isDisabled) return;
    itemContext.setActivatorNodeRef(node);
  });

  const HandlePrimitive = asChild ? SlotPrimitive.Slot : "button";

  return (
    <HandlePrimitive
      type="button"
      aria-controls={itemContext.id}
      data-disabled={isDisabled}
      data-dragging={itemContext.isDragging ? "" : undefined}
      data-slot="sortable-item-handle"
      {...itemHandleProps}
      {...(isDisabled ? {} : itemContext.attributes)}
      {...(isDisabled ? {} : itemContext.listeners)}
      ref={composedRef}
      className={cn(
        "select-none disabled:pointer-events-none disabled:opacity-50",
        context.flatCursor ? "cursor-default" : "cursor-grab data-dragging:cursor-grabbing",
        className,
      )}
      disabled={isDisabled}
    />
  );
}

const SortableOverlayContext = React.createContext(false);

const dropAnimation: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: "0.4",
      },
    },
  }),
};

type SortableOverlayProps = Omit<React.ComponentProps<typeof DragOverlay>, "children"> & {
  container?: Element | DocumentFragment | null;
  children?: ((params: { value: UniqueIdentifier }) => React.ReactNode) | React.ReactNode;
};

function SortableOverlay(props: SortableOverlayProps) {
  const { container: containerProp, children, ...overlayProps } = props;

  const context = useSortableContext(OVERLAY_NAME);

  const [mounted, setMounted] = React.useState(false);

  React.useLayoutEffect(() => {
    setMounted(true);
  }, []);

  const container = containerProp ?? (mounted ? globalThis.document.body : null);

  if (!container) return null;

  return ReactDOM.createPortal(
    <DragOverlay
      dropAnimation={dropAnimation}
      {...(context.modifiers ? { modifiers: context.modifiers } : {})}
      className={cn(!context.flatCursor && "cursor-grabbing")}
      {...overlayProps}
    >
      <SortableOverlayContext.Provider value={true}>
        {context.activeId ? (typeof children === "function" ? children({ value: context.activeId }) : children) : null}
      </SortableOverlayContext.Provider>
    </DragOverlay>,
    container,
  );
}

export { SortableContent, SortableItem, SortableItemHandle, SortableOverlay };

function useSortableItemPlacement(value: UniqueIdentifier): void {
  const inSortableContent = React.useContext(SortableContentContext);
  const inSortableOverlay = React.useContext(SortableOverlayContext);

  if (!inSortableContent && !inSortableOverlay) {
    throw new Error(`\`${ITEM_NAME}\` must be used within \`${CONTENT_NAME}\` or \`${OVERLAY_NAME}\``);
  }

  if (value === "") {
    throw new Error(`\`${ITEM_NAME}\` value cannot be an empty string`);
  }
}

function sortableItemClassName(
  asHandle: boolean | undefined,
  flatCursor: boolean,
  isDragging: boolean,
  disabled: boolean | undefined,
  className: string | undefined,
) {
  return cn(
    "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
    {
      "touch-none select-none": asHandle,
      "cursor-default": flatCursor,
      "data-dragging:cursor-grabbing": !flatCursor,
      "cursor-grab": !isDragging && asHandle && !flatCursor,
      "opacity-50": isDragging,
      "pointer-events-none opacity-50": disabled,
    },
    className,
  );
}
