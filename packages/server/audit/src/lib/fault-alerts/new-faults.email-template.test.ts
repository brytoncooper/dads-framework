/**
 * What: the new-faults alert renders each of its samples under the API
 * server's own TSX loader.
 * Why: the dev API runs through tsx with classic JSX; a template that leaves
 * React out of scope passes Vitest and then fails delivery with
 * "React is not defined".
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("newFaultsEmailTemplate", () => {
  it("renders every sample under the server's TSX loader", () => {
    const templateUrl = new URL("./new-faults.email-template.tsx", import.meta.url).href;
    const source = `
      import { renderEmailTemplate } from "@dads-framework/email/templates";
      import { newFaultsEmailTemplate as template } from ${JSON.stringify(templateUrl)};
      for (const props of Object.values(template.samples))
        await renderEmailTemplate(template, props);
      process.stdout.write("rendered");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: undefined },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("rendered");
  });
});
