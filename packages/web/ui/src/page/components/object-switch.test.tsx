/**
 * What: the object switch beside a list title — a segmented choice on wide
 * screens, a title dropdown on phones — and the header slot that places it.
 * Why: switching Orders to Releases changes what the page is about, so it
 * must read as part of the title at every width and still announce which
 * object is on screen.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ListPageHeader } from "./list-page.js";
import { ObjectSwitch } from "./object-switch.js";

type OrderObject = "orders" | "releases";

afterEach(cleanup);

function OrdersHeader() {
  const [value, setValue] = React.useState<OrderObject>("orders");
  return (
    <ListPageHeader
      title="Orders"
      objectSwitch={
        <ObjectSwitch
          label="Show"
          objects={[
            { value: "orders", label: "Orders" },
            { value: "releases", label: "Releases" },
          ]}
          value={value}
          onValueChange={setValue}
        />
      }
    />
  );
}

describe("ObjectSwitch", () => {
  it("marks the current object in the segmented choice and switches on click", () => {
    render(<OrdersHeader />);

    const segments = screen.getByRole("group", { name: "Show" });
    expect(segments.className).toContain("max-md:hidden");
    const orders = screen.getByRole("button", {
      name: "Orders",
      pressed: true,
    });
    expect(orders.className).toContain("text-link");

    fireEvent.click(screen.getByRole("button", { name: "Releases" }));
    expect(screen.getByRole("button", { name: "Releases", pressed: true })).toBeDefined();
    expect(screen.getByRole("button", { name: "Orders", pressed: false })).toBeDefined();
  });

  it("offers the choice from a title dropdown on phones", () => {
    const { container } = render(<OrdersHeader />);

    const title = container.querySelector<HTMLElement>('[data-slot="object-switch-title"]');
    expect(title?.className).toContain("md:hidden");
    expect(title?.getAttribute("aria-haspopup")).toBe("menu");
    expect(title?.textContent).toBe("Orders");
    if (!title) return;

    fireEvent.keyDown(title, { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Releases" }));
    expect(title.textContent).toBe("Releases");
  });

  it("keeps the page heading for assistive technology while the dropdown stands in for it on phones", () => {
    render(<OrdersHeader />);

    const heading = screen.getByRole("heading", { level: 1, name: "Orders" });
    expect(heading.className).toContain("max-md:sr-only");
  });

  it("leaves a header without a switch as a plain visible heading", () => {
    render(<ListPageHeader title="Tickets" />);

    expect(screen.getByRole("heading", { level: 1, name: "Tickets" }).className).not.toContain("sr-only");
  });
});
