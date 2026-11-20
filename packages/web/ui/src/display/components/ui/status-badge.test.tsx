/**
 * What: semantic statuses share one outlined badge and text-plus-lamp anatomy.
 * Why: three feature rosters duplicated the same shape, and color must never
 * carry the status meaning without a visible label.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { StatusBadge, StatusLamp, type StatusTone } from "./status-badge.js";

afterEach(cleanup);

const TONES: readonly {
  tone: StatusTone;
  lampClass: string;
  borderClass: string;
}[] = [
  {
    tone: "positive",
    lampClass: "bg-success",
    borderClass: "border-success/50",
  },
  {
    tone: "warning",
    lampClass: "bg-warning",
    borderClass: "border-warning-edge",
  },
  {
    tone: "critical",
    lampClass: "bg-destructive",
    borderClass: "border-destructive/50",
  },
  { tone: "information", lampClass: "bg-info", borderClass: "border-info/50" },
  {
    tone: "neutral",
    lampClass: "bg-muted-foreground",
    borderClass: "border-border",
  },
];

describe("StatusBadge", () => {
  it("requires a visible label in its public props", () => {
    type HasRequiredLabel =
      ComponentProps<typeof StatusBadge> extends {
        children: ReactNode;
      }
        ? true
        : false;

    expectTypeOf<HasRequiredLabel>().toEqualTypeOf<true>();
  });

  it("pairs every semantic lamp with a visible status label", () => {
    render(
      <div>
        {TONES.map(({ tone }) => (
          <StatusBadge key={tone} tone={tone} data-testid={tone}>
            {tone}
          </StatusBadge>
        ))}
      </div>,
    );

    for (const { tone, lampClass, borderClass } of TONES) {
      const badge = screen.getByTestId(tone);
      const lamp = badge.querySelector<HTMLElement>(
        '[data-slot="status-badge-lamp"]',
      );

      expect(badge.textContent).toBe(tone);
      expect(badge.className).toContain(borderClass);
      expect(badge.className).toContain("font-normal");
      expect(lamp?.getAttribute("aria-hidden")).toBe("true");
      expect(lamp?.className).toContain(lampClass);
    }
  });

  it("uses a muted lamp for the neutral status while preserving caller styling", () => {
    render(
      <StatusBadge tone="neutral" className="feature-status">
        Archived
      </StatusBadge>,
    );

    const badge = screen.getByText("Archived");
    const lamp = badge.querySelector<HTMLElement>(
      '[data-slot="status-badge-lamp"]',
    );

    expect(badge.className).toContain("feature-status");
    expect(lamp?.className).toContain("bg-muted-foreground");
  });

  it("exports the lamp alone as a decorative, tone-colored dot", () => {
    render(<StatusLamp tone="warning" className="feature-lamp" />);

    const lamp = document.querySelector<HTMLElement>(
      '[data-slot="status-lamp"]',
    );

    expect(lamp?.getAttribute("aria-hidden")).toBe("true");
    expect(lamp?.className).toContain("bg-warning");
    expect(lamp?.className).toContain("size-1.5");
    expect(lamp?.className).toContain("feature-lamp");
  });
});
