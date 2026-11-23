/**
 * What: FieldError renders only resolved, caller-owned messages and removes
 * duplicate sentences.
 * Why: passing form-library or Zod issue objects would make the primitive
 * render their English `message` fields and bypass the feature catalog.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FieldError } from "./field.js";

afterEach(cleanup);

describe("FieldError localized presentation boundary", () => {
  it("renders unique messages that the caller already resolved", () => {
    render(<FieldError messages={["Enter a name.", "Enter a name.", "Use 80 characters or fewer."]} />);

    const alert = screen.getByRole("alert");
    expect(alert.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("Enter a name.")).toBeDefined();
    expect(screen.getByText("Use 80 characters or fewer.")).toBeDefined();
  });

  it("lets explicitly resolved children own a single message", () => {
    render(<FieldError messages={["Ignored resolved message"]}>Choose a supported language.</FieldError>);

    expect(screen.getByText("Choose a supported language.")).toBeDefined();
    expect(screen.queryByText("Ignored resolved message")).toBeNull();
  });
});
