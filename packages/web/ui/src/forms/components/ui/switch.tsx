import { Switch as SwitchPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "../../../elements/index.js";

import { Label } from "./label.js";

type SwitchProps = React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
};

function Switch({ className, size = "default", ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input motion-reduce:transition-none",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground motion-reduce:transition-none",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

type SwitchFieldProps = Omit<
  SwitchProps,
  "aria-describedby" | "aria-label" | "aria-labelledby" | "className" | "id"
> & {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
  switchClassName?: string;
};

/**
 * A switch with one visible label, an optional accessible description, and a
 * 44-pixel row target. The track keeps Switch's visual size; the label owns the
 * larger pointer target.
 */
function SwitchField({ className, description, disabled, id, label, switchClassName, ...props }: SwitchFieldProps) {
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;

  return (
    <Label
      data-slot="switch-field"
      data-disabled={disabled ? "true" : undefined}
      htmlFor={id}
      className={cn(
        "min-h-11 w-full cursor-pointer items-center justify-between gap-4 rounded-md py-2 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:text-muted-foreground",
        className,
      )}
    >
      <span className="grid gap-1 leading-snug">
        <span id={labelId}>{label}</span>
        {description !== undefined && (
          <span id={descriptionId} className="text-sm font-normal text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      <Switch
        id={id}
        aria-labelledby={labelId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        className={switchClassName}
        disabled={disabled}
        {...props}
      />
    </Label>
  );
}

export { Switch, SwitchField };
