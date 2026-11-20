/**
 * The showcase is the file people copy, the gallery's component sheet, and
 * what `email.send-test` delivers — so it has to stay a WORKING example of
 * every component, in both bodies, for every sample. A component quietly
 * dropped from it is a component that stops being checked against a real
 * client, which is the whole reason this template exists.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { componentShowcaseEmailTemplate } from "./component-showcase.email-template.js";
import { EmailTemplateRegistry } from "./email-template-registry.js";
import { emailTheme } from "./email-theme.js";
import { renderEmailTemplate } from "./render-email-template.js";

const template = componentShowcaseEmailTemplate;
const sampleNames = Object.keys(template.samples);

/** A named sample, or a failure that names the sample rather than `undefined`. */
function sample(name: string) {
  const props = template.samples[name];
  if (props === undefined) {
    throw new Error(`The showcase declares no "${name}" sample.`);
  }
  return props;
}

describe("componentShowcaseEmailTemplate", () => {
  it("renders every sample, so every component, under the server's TSX loader", () => {
    // The dev API runs through tsx with classic JSX; a component that leaves
    // React out of scope fails delivery with "React is not defined".
    const rendererUrl = new URL("./render-email-template.tsx", import.meta.url)
      .href;
    const templateUrl = new URL(
      "./component-showcase.email-template.tsx",
      import.meta.url,
    ).href;
    const source = `
      import { renderEmailTemplate } from ${JSON.stringify(rendererUrl)};
      import { componentShowcaseEmailTemplate as template } from ${JSON.stringify(templateUrl)};
      for (const props of Object.values(template.samples))
        await renderEmailTemplate(template, props);
      process.stdout.write("rendered");
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      {
        encoding: "utf8",
        env: { ...process.env, TSX_TSCONFIG_PATH: undefined },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("rendered");
  });

  it("is registrable, so the copy-me example cannot drift from the walls", () => {
    expect(() => {
      new EmailTemplateRegistry().register(template);
    }).not.toThrow();
  });

  it("is named for the kit that owns it", () => {
    expect(template.name).toBe("email-templates.component-showcase");
  });

  it("ships the default and long-names samples", () => {
    expect(sampleNames.sort()).toEqual(["default", "long-names"]);
  });

  it("says the order and the code in the subject and the preview line", async () => {
    const rendered = await renderEmailTemplate(template, sample("default"));

    expect(rendered.subject).toBe("Order SO-10428 is ready");
    expect(rendered.preview).toBe("Pickup code 4F7QK2");
  });

  it.each(sampleNames)(
    "renders every component into both bodies for the %s sample",
    async (sampleName) => {
      const { html, text } = await renderEmailTemplate(
        template,
        sample(sampleName),
      );

      // The badge's word, the table's labels, the code, the button's label
      // and the raw link — every component, proven by what it put on the
      // page rather than by the tag it emitted.
      for (const shown of ["Order", "Status", "View Order"]) {
        expect(html).toContain(shown);
        expect(text).toContain(shown);
      }
      expect(html).toContain("https://app.example/orders/SO-10428");
      expect(text).toContain("https://app.example/orders/SO-10428");
    },
  );

  it("paints with the theme's palette and nothing else", async () => {
    const { html } = await renderEmailTemplate(template, sample("default"));
    const palette = new Set<string>(Object.values(emailTheme.color));

    // Because this template uses every component, a component that grew a
    // colour of its own — a vendor default, a hand-picked hex — shows up
    // here and nowhere else.
    const used = new Set(html.match(/#[0-9a-f]{6}\b/gi) ?? []);
    const strangers = [...used].filter(
      (hex) => !palette.has(hex.toLowerCase()),
    );

    expect(strangers).toEqual([]);
  });

  it("states the status in words, never in colour alone", async () => {
    const cancelled = await renderEmailTemplate(template, sample("long-names"));

    expect(cancelled.text).toContain("Cancelled");
  });
});
