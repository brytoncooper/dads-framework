/**
 * What: a tone bar is a labelled image whose fill width is clamped to 0-100
 * and whose fill color follows the semantic tone.
 * Why: remaining-interval bars must never overflow their track or rely on
 * color alone.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ToneBar } from "./tone-bar.js";

afterEach(cleanup);

function fillOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-slot="tone-bar-fill"]');
}

describe("ToneBar", () => {
  it("exposes the required label as an image", () => {
    render(<ToneBar percent={40} tone="positive" label="40% remaining" />);

    const bar = screen.getByRole("img", { name: "40% remaining" });

    expect(bar.getAttribute("data-slot")).toBe("tone-bar");
  });

  it("sizes the fill to the percent", () => {
    const { container } = render(<ToneBar percent={40} tone="positive" label="40% remaining" />);

    expect(fillOf(container)?.style.width).toBe("40%");
  });

  it("clamps values below 0 and above 100", () => {
    const low = render(<ToneBar percent={-25} tone="warning" label="Low" />);
    expect(fillOf(low.container)?.style.width).toBe("0%");
    low.unmount();

    const high = render(<ToneBar percent={250} tone="warning" label="High" />);
    expect(fillOf(high.container)?.style.width).toBe("100%");
  });

  it("treats NaN as empty", () => {
    const { container } = render(<ToneBar percent={Number.NaN} tone="neutral" label="Unknown" />);

    expect(fillOf(container)?.style.width).toBe("0%");
  });

  it("colors the fill by tone", () => {
    const { container } = render(<ToneBar percent={10} tone="critical" label="10% remaining" />);

    expect(fillOf(container)?.className).toContain("bg-destructive");
  });
});
