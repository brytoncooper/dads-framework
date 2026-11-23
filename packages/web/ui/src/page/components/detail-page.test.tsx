/**
 * What: detail pages share navigation, heading, section, tab, and state
 * geometry while stacked and tabbed feature content remains feature-owned.
 * Why: five detail pages currently change spacing and lose navigation as their
 * queries move between loading, success, and failure.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TabsContent, TabsTrigger } from "../../display/index.js";
import { Button } from "../../elements/index.js";

import { DetailBackLink, DetailHeader, DetailPage, DetailSection, DetailState, DetailTabs } from "./detail-page.js";

afterEach(cleanup);

describe("detail-page composition", () => {
  it("keeps navigation, one headline, actions, sections, and tabs on one grammar", () => {
    render(
      <DetailPage aria-label="Product Detail">
        <DetailBackLink asChild>
          <a href="/products">Products</a>
        </DetailBackLink>

        <DetailHeader
          title="Portland Cement"
          subtitle="PC-100"
          status={<span>Archived</span>}
          actions={<Button>Restore</Button>}
        >
          <p>Available to three facilities.</p>
        </DetailHeader>

        <DetailSection
          title="Availability"
          description="Facilities that may handle this product."
          actions={<Button variant="outline">Enable Product</Button>}
        >
          Section Body
        </DetailSection>

        <DetailTabs
          label="Product Views"
          defaultValue="general"
          triggers={
            <>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="recipe">Recipe</TabsTrigger>
            </>
          }
        >
          <TabsContent value="general">General Body</TabsContent>
          <TabsContent value="recipe">Recipe Body</TabsContent>
        </DetailTabs>
      </DetailPage>,
    );

    const page = screen.getByLabelText("Product Detail");
    const backLink = screen.getByRole("link", { name: "Products" });
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Portland Cement",
    });
    const sectionHeading = screen.getByRole("heading", {
      level: 2,
      name: "Availability",
    });
    const tabs = screen.getByRole("tablist", { name: "Product Views" });
    const tabsRoot = tabs.closest('[data-slot="tabs"]');

    expect(page.getAttribute("data-slot")).toBe("detail-page");
    expect(page.className).toContain("gap-6");
    expect(backLink.getAttribute("href")).toBe("/products");
    expect(backLink.className).toContain("text-link");
    expect(backLink.querySelector('[data-slot="detail-back-icon"]')).not.toBeNull();
    expect(heading.className).toContain("text-3xl");
    expect(screen.getByText("PC-100").tagName).toBe("P");
    expect(screen.getByText("Archived")).toBeDefined();
    expect(screen.getByRole("button", { name: "Restore" })).toBeDefined();
    expect(sectionHeading.className).toContain("text-2xl");
    expect(screen.getByText("Facilities that may handle this product.").tagName).toBe("P");
    expect(tabs.getAttribute("data-variant")).toBe("default");
    expect(tabsRoot?.className).toContain("gap-0");
    expect(tabsRoot?.className).toContain("[&_[data-slot=tabs-content]]:mt-6");
  });

  it("gives stacked and tabbed loading states distinct trustworthy geometry", () => {
    render(
      <div>
        <DetailState variant="loading" layout="stacked" label="Loading Product" />
        <DetailState variant="loading" layout="tabbed" label="Loading Order" />
      </div>,
    );

    const stacked = screen.getByRole("status", { name: "Loading Product" });
    const tabbed = screen.getByRole("status", { name: "Loading Order" });

    expect(stacked.getAttribute("aria-busy")).toBe("true");
    expect(stacked.getAttribute("data-layout")).toBe("stacked");
    expect(stacked.querySelector('[data-slot="detail-state-tabs"]')).toBeNull();
    expect(tabbed.getAttribute("data-layout")).toBe("tabbed");
    expect(tabbed.querySelector('[data-slot="detail-state-tabs"]')).not.toBeNull();

    for (const skeleton of Array.from(document.querySelectorAll<HTMLElement>('[data-slot="skeleton"]'))) {
      expect(skeleton.className).toContain("motion-reduce:animate-none");
    }

    for (const boundedSkeleton of Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="skeleton"][class*="max-w-"]'),
    )) {
      expect(boundedSkeleton.className.split(" ")).toContain("w-full");
    }
  });

  it("keeps feature-owned error copy and retry actions in a scoped state", () => {
    render(
      <DetailState variant="error" title="Product Could Not Be Loaded" description="The request timed out.">
        <Button>Try Again</Button>
      </DetailState>,
    );

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-slot")).toBe("detail-state");
    expect(screen.getByText("Product Could Not Be Loaded")).toBeDefined();
    expect(screen.getByText("The request timed out.")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Try Again" }).closest('[data-slot="detail-state-actions"]'),
    ).not.toBeNull();
  });

  it("omits optional slots when conditional feature content resolves false", () => {
    const { container } = render(
      <>
        <DetailHeader title="Portland Cement" subtitle={false} status={false} actions={false} />
        <DetailState variant="error" title="Product Could Not Be Loaded" description={false}>
          {false}
        </DetailState>
      </>,
    );

    expect(container.querySelector("header p")).toBeNull();
    expect(container.querySelector('[data-slot="detail-actions"]')).toBeNull();
    expect(container.querySelector('[data-slot="detail-state-actions"]')).toBeNull();
  });
});
