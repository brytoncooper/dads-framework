/**
 * What: list pages share one responsive shell, header/action cluster, and
 * page-level empty-state grammar.
 * Why: feature pages repeat this visual structure, but their wording,
 * permissions, queries, and actions must remain feature-owned.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "../../elements/index.js";

import {
  ListEmptyState,
  ListPageActions,
  ListPageHeader,
  ListPageShell,
} from "./list-page.js";

afterEach(cleanup);

describe("list-page composition", () => {
  it("keeps page content on one shared vertical rhythm", () => {
    render(
      <ListPageShell aria-label="Products" className="feature-page">
        Catalog
      </ListPageShell>,
    );

    const shell = screen.getByLabelText("Products");
    expect(shell.getAttribute("data-slot")).toBe("list-page-shell");
    expect(shell.className).toContain("flex");
    expect(shell.className).toContain("min-w-0");
    expect(shell.className).toContain("flex-1");
    expect(shell.className).toContain("flex-col");
    expect(shell.className).toContain("gap-6");
    expect(shell.className).toContain("feature-page");
  });

  it("stacks a page heading and feature-owned actions at narrow widths", () => {
    render(
      <ListPageHeader
        title="Products"
        description="Materials this organization recognizes."
      >
        <ListPageActions aria-label="Product Actions">
          <Button>New Product</Button>
        </ListPageActions>
      </ListPageHeader>,
    );

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Products",
    });
    const header = heading.closest("header");
    const description = screen.getByText(
      "Materials this organization recognizes.",
    );
    const actions = screen.getByLabelText("Product Actions");

    expect(heading.className).toContain("text-3xl");
    expect(heading.className).toContain("font-semibold");
    expect(header?.getAttribute("data-slot")).toBe("list-page-header");
    expect(header?.className).toContain("flex-col");
    expect(header?.className).toContain("sm:flex-row");
    expect(header?.className).toContain("sm:items-start");
    expect(description.tagName).toBe("P");
    expect(description.className).toContain("text-foreground");
    expect(description.className).not.toContain("text-muted-foreground");
    expect(actions.getAttribute("data-slot")).toBe("list-page-actions");
    expect(actions.className).toContain("w-full");
    expect(actions.className).toContain("flex-wrap");
    expect(actions.className).toContain("gap-2");
    expect(actions.className).toContain("sm:w-auto");
    expect(screen.getByRole("button", { name: "New Product" })).toBeDefined();
  });

  it("composes feature-owned empty copy, media, and actions from display primitives", () => {
    render(
      <ListEmptyState
        aria-label="Empty Catalog"
        className="feature-empty-state"
        icon={<svg data-testid="product-icon" />}
        title="No Products Yet"
        description="Create the first material in this catalog."
      >
        <Button>Create Product</Button>
      </ListEmptyState>,
    );

    const emptyState = screen.getByLabelText("Empty Catalog");
    const title = screen.getByRole("heading", {
      level: 2,
      name: "No Products Yet",
    });
    const description = screen.getByText(
      "Create the first material in this catalog.",
    );
    const media = screen.getByTestId("product-icon").parentElement;
    const action = screen.getByRole("button", { name: "Create Product" });

    expect(emptyState.getAttribute("data-slot")).toBe("list-empty-state");
    expect(emptyState.className).toContain("rounded-md");
    expect(emptyState.className).toContain("border");
    expect(emptyState.className).toContain("border-dashed");
    expect(emptyState.className).toContain("feature-empty-state");
    expect(title.getAttribute("data-slot")).toBe("empty-title");
    expect(description.tagName).toBe("P");
    expect(description.getAttribute("data-slot")).toBe("empty-description");
    expect(media?.getAttribute("data-slot")).toBe("empty-icon");
    expect(media?.getAttribute("aria-hidden")).toBe("true");
    expect(action.closest('[data-slot="empty-content"]')).not.toBeNull();
  });

  it("omits empty-state regions for content the feature did not supply", () => {
    const { container } = render(
      <ListEmptyState title="Nothing to Commission" />,
    );

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Nothing to Commission",
      }),
    ).toBeDefined();
    expect(container.querySelector('[data-slot="empty-icon"]')).toBeNull();
    expect(
      container.querySelector('[data-slot="empty-description"]'),
    ).toBeNull();
    expect(container.querySelector('[data-slot="empty-content"]')).toBeNull();
  });
});
