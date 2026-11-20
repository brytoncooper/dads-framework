/**
 * What: every primitive that sets text straight on the page background (no
 * card, popover or white surface between) uses the full foreground — never
 * `text-muted-foreground`, and never a faded `text-foreground/NN`.
 * Why: grey text on the grey page is hard to read. Muted text is for white
 * surfaces, where it still clears 4.5:1; on the page it does not read. Each
 * primitive is rendered with every slot filled, so a muted class added to any
 * part of it later fails here.
 * @vitest-environment jsdom
 */
import { cleanup, render } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { TabsContent, TabsTrigger } from "../../display/index.js";

import { SectionHeader } from "./content-hierarchy.js";
import { DetailHeader, DetailSection, DetailTabs } from "./detail-page.js";
import { ListEmptyState, ListPageHeader } from "./list-page.js";
import { ListViewTabs } from "./list-view-tabs.js";
import { ObjectSwitch } from "./object-switch.js";
import { SectionNav, SectionNavCount, SectionNavItem } from "./section-nav.js";

afterEach(cleanup);

/**
 * Class names that make text grey: muted ink, or the foreground faded. An
 * icon variant (`[&_svg…]:`) is not text, and a control's
 * `data-[placeholder]:` ink shows only while it holds no value.
 */
function isGreyTextClass(className: string): boolean {
  const cut = className.lastIndexOf(":");
  const variants = className.slice(0, Math.max(cut, 0));
  const utility = className.slice(cut + 1);
  if (variants.includes("_svg") || variants.includes("data-[placeholder]")) {
    return false;
  }
  return (
    utility === "text-muted-foreground" ||
    /^text-foreground\/\d+$/.test(utility)
  );
}

function greyTextClasses(container: HTMLElement): string[] {
  const found: string[] = [];
  for (const element of [container, ...container.querySelectorAll("*")]) {
    for (const className of element.classList) {
      if (isGreyTextClass(className)) {
        found.push(`<${element.tagName.toLowerCase()}> ${className}`);
      }
    }
  }
  return found;
}

const ignore = () => undefined;

const PAGE_BACKGROUND_PRIMITIVES: readonly (readonly [
  string,
  () => React.ReactElement,
])[] = [
  [
    "ListPageHeader",
    () => (
      <ListPageHeader
        title="Orders"
        description="Every order for this facility."
        objectSwitch={
          <ObjectSwitch
            label="Record Type"
            objects={[
              { value: "orders", label: "Orders" },
              { value: "releases", label: "Releases" },
            ]}
            value="orders"
            onValueChange={ignore}
          />
        }
      />
    ),
  ],
  [
    "ListViewTabs",
    () => (
      <ListViewTabs
        label="Order Status"
        views={[
          { value: "OPEN", label: "Open", count: 12 },
          { value: "DRAFT", label: "Draft", count: 3 },
          { value: "ALL", label: "All" },
        ]}
        value="OPEN"
        onValueChange={ignore}
      />
    ),
  ],
  [
    "ListEmptyState",
    () => (
      <ListEmptyState
        icon={<svg />}
        title="No orders yet"
        description="Orders you create appear here."
      >
        <button type="button">New Order</button>
      </ListEmptyState>
    ),
  ],
  [
    "DetailHeader",
    () => (
      <DetailHeader
        title="Order 1042"
        subtitle="Placed by North Mill"
        status={<span>Open</span>}
        actions={<button type="button">Edit</button>}
      />
    ),
  ],
  [
    "SectionHeader",
    () => (
      <SectionHeader
        title="History"
        description="Every change, newest first."
        actions={<button type="button">Export</button>}
      />
    ),
  ],
  [
    "DetailSection",
    () => (
      <DetailSection title="Tasks" description="What is left to do.">
        <span>Body</span>
      </DetailSection>
    ),
  ],
  [
    "DetailTabs",
    () => (
      <DetailTabs
        label="Order Areas"
        defaultValue="summary"
        triggers={
          <>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </>
        }
      >
        <TabsContent value="summary">Summary</TabsContent>
      </DetailTabs>
    ),
  ],
  [
    "SectionNav",
    () => (
      <SectionNav label="Areas">
        <SectionNavItem current>
          Identity <SectionNavCount>2</SectionNavCount>
        </SectionNavItem>
        <SectionNavItem current={false}>
          Email <SectionNavCount>4</SectionNavCount>
        </SectionNavItem>
      </SectionNav>
    ),
  ],
];

describe("text on the page background", () => {
  it.each(PAGE_BACKGROUND_PRIMITIVES)(
    "%s never sets grey text on the grey page",
    (_name, renderPrimitive) => {
      const { container } = render(renderPrimitive());
      expect(greyTextClasses(container)).toEqual([]);
    },
  );
});
