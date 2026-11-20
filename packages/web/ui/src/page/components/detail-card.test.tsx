/**
 * What: a detail card is one titled surface with optional icon, description,
 * actions, and footer around its body.
 * Why: detail pages group related content into one card per job, and every
 * label is the caller's.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "../../elements/index.js";

import { DetailCard } from "./detail-card.js";

afterEach(cleanup);

describe("DetailCard", () => {
  it("titles the section with a level-2 heading and renders the body", () => {
    render(
      <DetailCard title="Schedule" aria-label="Schedule Card">
        <p>Every 30 days</p>
      </DetailCard>,
    );

    const card = screen.getByLabelText("Schedule Card");

    expect(card.getAttribute("data-slot")).toBe("detail-card");
    expect(
      screen.getByRole("heading", { level: 2, name: "Schedule" }),
    ).toBeTruthy();
    expect(screen.getByText("Every 30 days")).toBeTruthy();
  });

  it("renders icon, description, actions, and footer when given", () => {
    const { container } = render(
      <DetailCard
        title="Tasks"
        icon={<svg data-testid="card-icon" aria-hidden="true" />}
        description="Work to do at each stop."
        actions={<Button>Add Task</Button>}
        footer={<Button variant="outline">Edit Route</Button>}
      >
        <p>Body</p>
      </DetailCard>,
    );

    expect(screen.getByTestId("card-icon")).toBeTruthy();
    expect(screen.getByText("Work to do at each stop.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Route" })).toBeTruthy();
    expect(container.querySelector('[data-slot="detail-card-icon"]')).not.toBe(
      null,
    );
    expect(
      container
        .querySelector('[data-slot="detail-card-footer"]')
        ?.contains(screen.getByRole("button", { name: "Edit Route" })),
    ).toBe(true);
  });

  it("omits optional structure when it is not provided", () => {
    const { container } = render(
      <DetailCard title="Notes" description={false} actions={false}>
        <p>Body</p>
      </DetailCard>,
    );

    expect(container.querySelector('[data-slot="detail-card-icon"]')).toBe(
      null,
    );
    expect(container.querySelector('[data-slot="detail-card-actions"]')).toBe(
      null,
    );
    expect(container.querySelector('[data-slot="detail-card-footer"]')).toBe(
      null,
    );
    expect(container.querySelector("p.text-muted-foreground")).toBe(null);
  });

  it("marks flush cards and drops the body's horizontal padding", () => {
    const { container } = render(
      <DetailCard title="Service History" flush>
        <table />
      </DetailCard>,
    );

    const card = container.querySelector('[data-slot="detail-card"]');
    const body = container.querySelector('[data-slot="detail-card-body"]');

    expect(card?.getAttribute("data-flush")).toBe("true");
    expect(body?.className).not.toContain("px-4");
  });

  it("keeps padded bodies unflagged by default", () => {
    const { container } = render(
      <DetailCard title="Details">
        <p>Body</p>
      </DetailCard>,
    );

    const card = container.querySelector('[data-slot="detail-card"]');
    const body = container.querySelector('[data-slot="detail-card-body"]');

    expect(card?.getAttribute("data-flush")).toBeNull();
    expect(body?.className).toContain("px-4");
  });
});
