/**
 * What: web plugins compose their pages without any server code.
 * Why: a web bundle must not import a plugin's routes, jobs, or migrations.
 */
import { describe, expect, it } from "vitest";

import { composeWebApp, defineWebPlugin } from "./define-web-plugin.js";

describe("composeWebApp", () => {
  it("lists every plugin's pages in the order the app listed the plugins", () => {
    const notes = defineWebPlugin({
      name: "notes",
      pages: [{ path: "/notes", title: "Notes" }],
    });
    const settings = defineWebPlugin({
      name: "settings",
      pages: [{ path: "/settings", title: "Settings" }],
    });

    expect(composeWebApp([notes, settings]).pages.map((page) => page.path)).toEqual(["/notes", "/settings"]);
  });

  it("refuses two plugins claiming one page path", () => {
    const one = defineWebPlugin({ name: "one", pages: [{ path: "/home" }] });
    const two = defineWebPlugin({ name: "two", pages: [{ path: "/home" }] });

    expect(() => composeWebApp([one, two])).toThrow("page /home is contributed by both one and two");
  });

  it("refuses a repeated web plugin name", () => {
    const one = defineWebPlugin({ name: "one" });

    expect(() => composeWebApp([one, one])).toThrow("unique names");
  });
});
