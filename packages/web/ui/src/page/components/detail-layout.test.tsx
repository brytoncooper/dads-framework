/**
 * What: detail columns place the main work before the reference aside.
 * Why: below lg the page is one column, so DOM order is what puts the primary
 * content first on phones.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DetailAside, DetailColumns, DetailMain } from "./detail-layout.js";

afterEach(cleanup);

describe("detail layout", () => {
  it("renders the columns, main, and aside slots", () => {
    const { container } = render(
      <DetailColumns>
        <DetailMain>
          <p>Main content</p>
        </DetailMain>
        <DetailAside aria-label="Reference">
          <p>Aside content</p>
        </DetailAside>
      </DetailColumns>,
    );

    expect(container.querySelector('[data-slot="detail-columns"]')).not.toBe(null);
    expect(container.querySelector('[data-slot="detail-main"]')).not.toBe(null);
    expect(screen.getByRole("complementary", { name: "Reference" })).toBeTruthy();
    expect(screen.getByText("Main content")).toBeTruthy();
    expect(screen.getByText("Aside content")).toBeTruthy();
  });

  it("keeps Main before Aside in the DOM", () => {
    const { container } = render(
      <DetailColumns>
        <DetailMain />
        <DetailAside />
      </DetailColumns>,
    );

    const main = container.querySelector('[data-slot="detail-main"]');
    const aside = container.querySelector('[data-slot="detail-aside"]');

    if (!main || !aside) throw new Error("expected main and aside slots");

    expect(main.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("splits into two columns only at lg", () => {
    const { container } = render(<DetailColumns />);

    const columns = container.querySelector('[data-slot="detail-columns"]');

    expect(columns?.className).toContain("lg:grid-cols-");
    expect(columns?.className).not.toMatch(/(^|\s)grid-cols-/);
  });
});
