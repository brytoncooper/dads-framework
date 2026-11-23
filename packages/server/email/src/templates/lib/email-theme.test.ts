/** Checks that the default theme uses styles email clients can render inline. */
import { describe, expect, it } from "vitest";
import { emailTheme } from "./email-theme.js";

const HEX = /^#[0-9a-f]{6}$/;

describe("emailTheme", () => {
  it("gives every colour as a 7-character lowercase hex", () => {
    for (const [name, value] of Object.entries(emailTheme.color)) {
      expect(value, name).toMatch(HEX);
    }
  });

  it("carries the three brand colours DESIGN.md states in hex", () => {
    expect(emailTheme.color.primary).toBe("#304fa2");
    expect(emailTheme.color.brand).toBe("#563b83");
    expect(emailTheme.color.logoAccent).toBe("#3f7374");
  });

  it("sizes and spacing are absolute px, never rem", () => {
    const scales = [
      emailTheme.fontSize,
      emailTheme.lineHeight,
      emailTheme.space,
      emailTheme.radius,
    ];
    for (const scale of scales) {
      for (const [name, value] of Object.entries(scale)) {
        expect(value, name).toMatch(/^\d+px$/);
      }
    }
  });

  it("names IBM Plex first and falls back without a webfont", () => {
    expect(emailTheme.font.sans).toContain("'IBM Plex Sans'");
    expect(emailTheme.font.sans).toContain("sans-serif");
    expect(emailTheme.font.mono).toContain("'IBM Plex Mono'");
    expect(emailTheme.font.mono).toContain("monospace");
  });

  it("holds the message to the 600px every client agrees on", () => {
    expect(emailTheme.contentWidth).toBe(600);
  });

  it("is frozen, group by group, so no template can bend the palette", () => {
    expect(Object.isFrozen(emailTheme)).toBe(true);
    for (const group of Object.values(emailTheme)) {
      if (typeof group !== "object") continue;
      expect(Object.isFrozen(group)).toBe(true);
    }
  });
});
