"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "../../../elements/index.js";

function Tabs({ className, orientation = "horizontal", ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn("group/tabs flex gap-2 data-[orientation=horizontal]:flex-col", className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "group/tabs-list isolate inline-flex w-fit items-center justify-center rounded-md text-foreground [@media(pointer:coarse)]:min-h-[50px] group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=horizontal]/tabs:max-w-full group-data-[orientation=horizontal]/tabs:justify-start group-data-[orientation=horizontal]/tabs:overflow-x-auto group-data-[orientation=horizontal]/tabs:overflow-y-hidden group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
  {
    variants: {
      variant: {
        default: "",
        line: "",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "group/tabs-trigger inline-flex h-9 min-w-9 flex-auto items-center justify-center gap-1.5 border border-input bg-background px-3 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] outline-none [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 group-data-[orientation=horizontal]/tabs:shrink-0 group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:bg-primary-hover hover:text-primary-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:z-10 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:z-10 data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 motion-reduce:transition-none",
        "rounded-none shadow-none group-data-[orientation=horizontal]/tabs:border-l-0 group-data-[orientation=horizontal]/tabs:first:rounded-l-md group-data-[orientation=horizontal]/tabs:first:border-l group-data-[orientation=horizontal]/tabs:last:rounded-r-md group-data-[orientation=vertical]/tabs:border-t-0 group-data-[orientation=vertical]/tabs:first:rounded-t-md group-data-[orientation=vertical]/tabs:first:border-t group-data-[orientation=vertical]/tabs:last:rounded-b-md",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("flex-1 outline-none", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
