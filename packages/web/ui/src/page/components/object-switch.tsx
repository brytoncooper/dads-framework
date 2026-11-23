import { cn } from "../../elements/index.js";
import { ChevronDown } from "../../icons/index.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../overlays/index.js";

/** One kind of record a list page can show, such as Orders or Releases. */
export type ListObject<TValue extends string> = {
  readonly value: TValue;
  readonly label: string;
};

type ObjectSwitchProps<TValue extends string> = {
  /** What the choice is, for assistive technology: "Show". */
  readonly label: string;
  readonly objects: readonly ListObject<TValue>[];
  readonly value: TValue;
  readonly onValueChange: (value: TValue) => void;
  readonly className?: string;
};

/**
 * Switches what a list page is looking at (Orders | Releases), so it sits
 * with the title, not the filters; pass it to `ListPageHeader` as
 * `objectSwitch`. Wide screens show a compact segmented control; phones show
 * the current object as the title with a chevron that opens the choice.
 */
export function ObjectSwitch<TValue extends string>({
  label,
  objects,
  value,
  onValueChange,
  className,
}: ObjectSwitchProps<TValue>) {
  const current = objects.find((object) => object.value === value);

  return (
    <div data-slot="object-switch" className={cn("min-w-0", className)}>
      <div
        role="group"
        aria-label={label}
        data-slot="object-switch-segments"
        className="inline-flex rounded-md border border-border bg-background p-0.5 max-md:hidden"
      >
        {objects.map((object) => {
          const isCurrent = object.value === value;
          return (
            <button
              key={object.value}
              type="button"
              aria-pressed={isCurrent}
              className={cn(
                "inline-flex h-7 items-center rounded-sm px-3 text-sm font-medium text-foreground outline-none transition-colors motion-reduce:transition-none",
                "focus-visible:ring-2 focus-visible:ring-ring/50",
                isCurrent ? "bg-primary/10 text-link" : "hover:bg-accent",
              )}
              onClick={() => {
                onValueChange(object.value);
              }}
            >
              {object.label}
            </button>
          );
        })}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-slot="object-switch-title"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md text-2xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:hidden"
          >
            <span className="truncate">{current?.label}</span>
            <ChevronDown aria-hidden="true" className="size-5 shrink-0 text-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-40">
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => {
              const chosen = objects.find((object) => object.value === next);
              if (chosen !== undefined) onValueChange(chosen.value);
            }}
          >
            {objects.map((object) => (
              <DropdownMenuRadioItem key={object.value} value={object.value}>
                {object.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
