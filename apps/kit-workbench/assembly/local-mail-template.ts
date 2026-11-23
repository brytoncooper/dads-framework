import type { RenderEmailTemplate } from "@dads-framework/email/delivery";
import {
  createEmailTemplateRegistry,
  defineEmailTemplate,
  EmailButton,
  renderEmailTemplate,
} from "@dads-framework/email/templates";
import { createElement } from "react";
import { z } from "zod";
import { accountMailDescription, accountMailTitle } from "./copy/account-mail.js";

const props = z.strictObject({ kind: z.string().min(1), url: z.url() });
export const starterMailTemplate = defineEmailTemplate({
  name: "starter.account-link",
  description: accountMailDescription,
  props,
  subject: ({ kind }) => accountMailTitle(kind),
  preview: ({ kind }) => accountMailTitle(kind),
  body: ({ kind, url }) => createElement(EmailButton, { href: url, children: accountMailTitle(kind) }),
  samples: {
    verification: {
      kind: "verify-email",
      url: "https://starter.example.test/verify",
    },
  },
});

const registry = createEmailTemplateRegistry([starterMailTemplate]);
export const starterMailTemplates = {
  find: (name: string) => registry.find(name)?.definition,
};

export const renderStarterMail: RenderEmailTemplate = (template, value) => {
  if (template.name !== starterMailTemplate.name) {
    throw new Error("Unknown starter email template.");
  }
  return renderEmailTemplate(starterMailTemplate, props.parse(value), {});
};
