/**
 * What: a stat strip is a description list of labelled numbers with an
 * optional semantic lamp and hint.
 * Why: the answer to "what state is this record in" leads every detail page,
 * and color must never carry it alone.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StatItem, StatStrip } from "./stat-strip.js";

afterEach(cleanup);

describe("StatStrip", () => {
  it("pairs each label (dt) with its value (dd) inside a grouped dl", () => {
    const { container } = render(
      <StatStrip aria-label="Service Summary">
        <StatItem label="Remaining" value="3 days" />
        <StatItem label="Interval" value="30 days" />
      </StatStrip>,
    );

    const strip = screen.getByRole("group", { name: "Service Summary" });
    const labels = Array.from(container.querySelectorAll("dt")).map(
      (dt) => dt.textContent,
    );
    const values = Array.from(container.querySelectorAll("dd")).map(
      (dd) => dd.textContent,
    );

    expect(strip.tagName).toBe("DL");
    expect(labels).toEqual(["Remaining", "Interval"]);
    expect(values).toEqual(["3 days", "30 days"]);
  });

  it("renders a lamp only when a tone is set", () => {
    const { container } = render(
      <StatStrip>
        <StatItem label="Due" value="Oct 7" tone="warning" />
        <StatItem label="Last Serviced" value="Sep 7" />
      </StatStrip>,
    );

    const items = container.querySelectorAll('[data-slot="stat-item"]');

    expect(items[0]?.querySelector('[data-slot="status-lamp"]')).not.toBe(null);
    expect(items[0]?.getAttribute("data-tone")).toBe("warning");
    expect(items[1]?.querySelector('[data-slot="status-lamp"]')).toBe(null);
  });

  it("colors the value destructive only for the critical tone", () => {
    render(
      <StatStrip>
        <StatItem label="Overdue By" value="1 day" tone="critical" />
        <StatItem label="Remaining" value="3 days" tone="positive" />
      </StatStrip>,
    );

    expect(screen.getByText("1 day").className).toContain("text-destructive");
    expect(screen.getByText("3 days").className).not.toContain(
      "text-destructive",
    );
  });

  it("shows a hint line only when one is given", () => {
    render(
      <StatStrip>
        <StatItem label="Interval" value="30" hint="days" />
        <StatItem label="Remaining" value="3" hint={false} />
      </StatStrip>,
    );

    expect(screen.getByText("days")).toBeTruthy();
    expect(document.querySelectorAll("dd")).toHaveLength(3);
  });

  it("draws its own surface as a card and none when plain", () => {
    const card = render(
      <StatStrip data-testid="card">
        <StatItem label="A" value="1" />
      </StatStrip>,
    );
    const cardStrip = screen.getByTestId("card");

    expect(cardStrip.getAttribute("data-variant")).toBe("card");
    expect(cardStrip.className).toContain("border");
    expect(
      card.container.querySelector('[data-slot="stat-item"]')?.className,
    ).toContain("bg-card");
    card.unmount();

    render(
      <StatStrip variant="plain" data-testid="plain">
        <StatItem label="A" value="1" />
      </StatStrip>,
    );
    const plainStrip = screen.getByTestId("plain");

    expect(plainStrip.getAttribute("data-variant")).toBe("plain");
    expect(plainStrip.className).not.toContain("rounded-lg");
    expect(
      document.querySelector('[data-slot="stat-item"]')?.className,
    ).not.toContain("bg-card");
  });
});
