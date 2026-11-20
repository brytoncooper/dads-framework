/**
 * What: headings, metadata, and non-overlay form actions use one semantic and
 * responsive hierarchy.
 * Why: feature pages currently encode the same relationships with fourteen
 * heading signatures and twenty-two hand-rolled action clusters.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "../../elements/index.js";

import {
  FormActions,
  MetadataItem,
  MetadataList,
  SectionHeader,
  SubsectionHeading,
} from "./content-hierarchy.js";

afterEach(cleanup);

describe("content hierarchy", () => {
  it("uses semantic section and subsection headings with feature-owned actions", () => {
    render(
      <section>
        <SectionHeader
          title="Available At"
          description="Facilities that can handle this product."
          actions={<Button>Enable Product</Button>}
        />
        <SubsectionHeading>Organization Defaults</SubsectionHeading>
      </section>,
    );

    const sectionHeading = screen.getByRole("heading", {
      level: 2,
      name: "Available At",
    });
    const subsectionHeading = screen.getByRole("heading", {
      level: 3,
      name: "Organization Defaults",
    });
    const sectionHeader = sectionHeading.closest("header");

    expect(sectionHeading.className).toContain("text-2xl");
    expect(subsectionHeading.className).toContain("text-xl");
    expect(sectionHeader?.className).toContain("sm:flex-row");
    expect(
      screen.getByRole("button", { name: "Enable Product" }),
    ).toBeDefined();
  });

  it("renders reusable metadata as a responsive description list", () => {
    render(
      <MetadataList aria-label="Product Metadata">
        <MetadataItem label="Code">
          <code>PC-100</code>
        </MetadataItem>
        <MetadataItem label="Status">Active</MetadataItem>
      </MetadataList>,
    );

    const list = screen.getByRole("group", { name: "Product Metadata" });
    const codeLabel = screen.getByText("Code");
    const codeValue = screen.getByText("PC-100");

    expect(list.tagName).toBe("DL");
    expect(list.className).toContain("sm:grid-cols-2");
    expect(codeLabel.tagName).toBe("DT");
    expect(codeValue.closest("dd")).not.toBeNull();
  });

  it("keeps secondary-before-primary DOM order while stacking actions narrowly", () => {
    render(
      <FormActions aria-label="Form Actions">
        <Button variant="outline">Cancel</Button>
        <Button>Save Changes</Button>
      </FormActions>,
    );

    const actions = screen.getByLabelText("Form Actions");
    const buttons = screen.getAllByRole("button");

    expect(actions.className).toContain("flex-col-reverse");
    expect(actions.className).toContain("sm:flex-row");
    expect(actions.className).toContain("sm:justify-end");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Cancel",
      "Save Changes",
    ]);
  });

  it("left-aligns actions with primary-first DOM order when align is start", () => {
    render(
      <FormActions aria-label="Form Actions" align="start">
        <Button>Save Changes</Button>
        <Button variant="outline">Cancel</Button>
      </FormActions>,
    );

    const actions = screen.getByLabelText("Form Actions");
    const buttons = screen.getAllByRole("button");

    expect(actions.getAttribute("data-align")).toBe("start");
    expect(actions.className).toContain("sm:justify-start");
    expect(actions.className).not.toContain("flex-col-reverse");
    expect(actions.className).not.toContain("sm:justify-end");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Save Changes",
      "Cancel",
    ]);
  });

  it("omits optional structure when a permission expression resolves false", () => {
    const { container } = render(
      <SectionHeader
        title="Availability"
        description={false}
        actions={false}
      />,
    );

    expect(container.querySelector("p")).toBeNull();
    expect(container.querySelector('[data-slot="section-actions"]')).toBeNull();
  });
});
