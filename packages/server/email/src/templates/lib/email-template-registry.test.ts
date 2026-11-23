/**
 * The registry is where a bad template is supposed to die: at boot, with the
 * template named, rather than at send time in front of an operator. So every
 * wall gets a case, and each case is written as the mistake someone actually
 * makes — a scaffold's "TODO" description, a sample left behind when the
 * props changed, two domains picking the same name.
 *
 * The other half is what `find()` hands the preview gallery, including the
 * one answer a gallery must be able to get without an exception: an unknown
 * sample is `undefined`, not a throw.
 *
 * The fixture is built with `createElement` rather than JSX so this file can
 * stay `.ts` — what is under test here is the registration walls, and none of
 * them render anything.
 */
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { componentShowcaseEmailTemplate } from "./component-showcase.email-template.js";
import {
  defineEmailTemplate,
  type EmailTemplateDefinition,
} from "./email-template.js";
import {
  createEmailTemplateRegistry,
  EmailTemplateRegistry,
} from "./email-template-registry.js";

const noticeTemplate = defineEmailTemplate({
  name: "email-templates.registry-test-notice",
  description: "A template that exists only to exercise the registry walls.",
  props: z.object({
    name: z.string().meta({ description: "Who the message greets" }),
  }),
  subject: () => "Notice",
  body: ({ name }) => createElement("p", null, name),
  samples: { named: { name: "Dana" }, "no-name": { name: "" } },
});

/**
 * A case that breaks one wall, built by overriding a field of the valid
 * template — the registry's parameter is the erased definition, so an
 * override the authoring door would reject still compiles here.
 */
function withOverrides(
  overrides: Partial<EmailTemplateDefinition<z.ZodType>>,
): EmailTemplateDefinition<z.ZodType> {
  return { ...noticeTemplate, ...overrides };
}

describe("EmailTemplateRegistry.register", () => {
  it("accepts the reference showcase template", () => {
    const registry = new EmailTemplateRegistry();

    expect(() => {
      registry.register(componentShowcaseEmailTemplate);
    }).not.toThrow();
  });

  it.each(["NoDots", "Bad.Case", "trailing.", ".leading", "two.dots.here", ""])(
    "refuses the name %o",
    (name) => {
      const registry = new EmailTemplateRegistry();

      expect(() => {
        registry.register(withOverrides({ name }));
      }).toThrow(/<domain>\.<kebab-name>/);
    },
  );

  it("refuses a scaffold's TODO description", () => {
    const registry = new EmailTemplateRegistry();

    expect(() => {
      registry.register(withOverrides({ description: "TODO" }));
    }).toThrow(/at least 20 characters/);
  });

  it("refuses props that are not an object schema", () => {
    const registry = new EmailTemplateRegistry();

    expect(() => {
      registry.register(withOverrides({ props: z.string() }));
    }).toThrow(/object props schema/);
  });

  it("refuses a template with no samples", () => {
    const registry = new EmailTemplateRegistry();

    expect(() => {
      registry.register(withOverrides({ samples: {} }));
    }).toThrow(/declares no samples/);
  });

  it("refuses a sample the props schema no longer accepts", () => {
    const registry = new EmailTemplateRegistry();

    expect(() => {
      registry.register(withOverrides({ samples: { named: { name: 7 } } }));
    }).toThrow(/sample "named" does not match its props schema/);
  });

  it("refuses a second template with a name already taken", () => {
    const registry = new EmailTemplateRegistry();
    registry.register(noticeTemplate);

    expect(() => {
      registry.register(noticeTemplate);
    }).toThrow(/already registered/);
  });
});

describe("EmailTemplateRegistry.find", () => {
  const registry = createEmailTemplateRegistry([
    componentShowcaseEmailTemplate,
    noticeTemplate,
  ]);

  it("answers nothing for a template that was never registered", () => {
    expect(registry.find("identity.nope")).toBeUndefined();
  });

  it("carries the metadata, the sorted sample names and a generated schema", () => {
    const found = registry.find("email-templates.registry-test-notice");

    expect(found?.description).toBe(noticeTemplate.description);
    expect(found?.sampleNames).toEqual(["named", "no-name"]);
    expect(found?.propsJsonSchema["type"]).toBe("object");
    expect(found?.definition).toBe(noticeTemplate);
  });

  it("renders a named sample", async () => {
    const rendered = await registry
      .find("email-templates.component-showcase")
      ?.renderSample("default");

    expect(rendered?.subject).toBe("Order SO-10428 is ready");
    expect(rendered?.html).toContain("4F7QK2");
    expect(rendered?.text).toContain("4F7QK2");
  });

  it("answers nothing for a sample the template does not declare", () => {
    const found = registry.find("email-templates.component-showcase");

    expect(found?.renderSample("missing")).toBeUndefined();
  });
});

describe("EmailTemplateRegistry.list", () => {
  it("sorts by name so a gallery never reorders between boots", () => {
    const registry = createEmailTemplateRegistry([
      noticeTemplate,
      componentShowcaseEmailTemplate,
    ]);

    expect(registry.list().map((template) => template.name)).toEqual([
      "email-templates.component-showcase",
      "email-templates.registry-test-notice",
    ]);
  });
});
