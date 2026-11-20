/**
 * What: breadcrumb and sidebar defaults live in the Shell catalog.
 * Why: the shell owns these accessible names, while page and navigation labels
 * supplied through children remain caller-owned data.
 */
import { describe, expect, it } from "vitest";

import {
  assertCatalogParity,
  mergeCopy,
  translate,
} from "@dads-framework/copy";

import { shellCopy } from "./shell-copy.js";

describe("shellCopy", () => {
  it("owns breadcrumb accessibility copy", () => {
    expect(translate(shellCopy, "en", "shell.breadcrumb.label")).toBe(
      "Breadcrumb",
    );
    expect(translate(shellCopy, "en", "shell.breadcrumb.more")).toBe("More");
  });

  it("owns sidebar accessibility copy", () => {
    expect(translate(shellCopy, "en", "shell.sidebar.title")).toBe("Sidebar");
    expect(translate(shellCopy, "en", "shell.sidebar.mobileDescription")).toBe(
      "App navigation.",
    );
    expect(translate(shellCopy, "en", "shell.sidebar.toggle")).toBe(
      "Toggle Sidebar",
    );
  });

  it("has every supported locale for every phrase", () => {
    const merged = mergeCopy([{ file: "shell-copy.ts", entries: shellCopy }]);
    expect(() => {
      assertCatalogParity(merged);
    }).not.toThrow();
  });
});
