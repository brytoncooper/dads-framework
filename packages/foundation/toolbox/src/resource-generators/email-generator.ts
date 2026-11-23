import type { GenerationPlan } from "./generation-plan.js";
import { camel, title } from "./names.js";

export function addEmail(
  plan: GenerationPlan,
  domain: string,
  name: string,
): void {
  const template = `${camel(name)}EmailTemplate`;
  const directory = `domains/${domain}/server/email`;
  plan.create(
    `${directory}/${name}.ts`,
    `import { defineEmailTemplate, EmailText } from "@dads-framework/email/templates";
import { createElement } from "react";
import { z } from "zod";

export const ${template} = defineEmailTemplate({
  name: "${domain}.${name}",
  description: "Sends the recipient a short ${title(name)} update.",
  props: z.strictObject({ message: z.string().min(1).meta({ description: "Message shown to this recipient" }) }),
  subject: () => "${title(name)}",
  body: ({ message }) => createElement(EmailText, { children: message }),
  samples: { example: { message: "An example message." } },
});
`,
  );
  plan.create(
    `${directory}/${name}.test.ts`,
    `import { renderEmailTemplate } from "@dads-framework/email/templates";
import { expect, it } from "vitest";

import { ${template} } from "./${name}.js";

it("renders the message in HTML and plain text", async () => {
  const rendered = await renderEmailTemplate(${template}, { message: "Your update is available." });
  expect(rendered.html).toContain("Your update is available.");
  expect(rendered.text).toContain("Your update is available.");
});
`,
  );
}
