import React from "react";
import type { ReactElement } from "react";
import { z } from "zod";

import {
  EmailLayout,
  type EmailLayoutProps,
} from "./components/email-layout.js";
import type { EmailBranding } from "./email-branding.js";
import type { EmailTemplateDefinition } from "./email-template.js";
import {
  createReactEmailDocumentRenderer,
  type EmailDocumentRenderer,
} from "./email-document-renderer.js";

/**
 * One template plus one set of props becomes one message: the subject, the
 * inbox preview line, and the two bodies — rendered from the SAME element, so
 * the plain-text twin cannot drift from the HTML the way a hand-written one
 * does. The text part is what a spam filter reads and what a plain-text
 * client shows, so it is not a courtesy copy.
 *
 * Pure: no I/O, no `process.env`, no clock. Everything that varies is a prop.
 */

/** One message, both bodies. */
export type RenderedEmail = {
  readonly subject: string;
  /** The inbox preview line, when the template declares one. */
  readonly preview?: string;
  readonly html: string;
  readonly text: string;
};

/** Builds a template renderer using a provider that produces both body formats. */
export function createEmailTemplateRenderer(
  renderer: EmailDocumentRenderer,
): EmailTemplateRenderer {
  return async (template, props, branding) => {
    const parsed = parseProps(template, props);
    const subject = template.subject(parsed);
    const preview = template.preview?.(parsed);
    const document = buildDocument(template, parsed, {
      subject,
      ...(preview === undefined ? {} : { preview }),
      branding,
    });
    const { html, text } = await renderer.render(document);
    return {
      subject,
      ...(preview === undefined ? {} : { preview }),
      html,
      text,
    };
  };
}

export type EmailTemplateRenderer = <TProps extends z.ZodObject>(
  template: EmailTemplateDefinition<TProps>,
  props: z.input<TProps>,
  branding?: EmailBranding,
) => Promise<RenderedEmail>;

export const renderEmailTemplate: EmailTemplateRenderer =
  createEmailTemplateRenderer(createReactEmailDocumentRenderer());

/**
 * Props are parsed, never trusted — but a failure here is a PROGRAMMING
 * error, not a user's: the caller is a mutation that built the props itself,
 * or an outbox row a previous version of this code wrote. So it throws with
 * the template's name attached rather than returning a `Result` nobody at the
 * call site could act on.
 */
function parseProps<TProps extends z.ZodObject>(
  template: EmailTemplateDefinition<TProps>,
  props: z.input<TProps>,
): z.output<TProps> {
  const parsed = template.props.safeParse(props);
  if (!parsed.success) {
    throw new Error(
      `Email template "${template.name}" was rendered with props it does not accept: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Every template renders inside the same frame; no template writes `<Html>`. */
function buildDocument<TProps extends z.ZodObject>(
  template: EmailTemplateDefinition<TProps>,
  props: z.output<TProps>,
  frame: Pick<EmailLayoutProps, "subject" | "preview" | "branding">,
): ReactElement {
  return <EmailLayout {...frame}>{template.body(props)}</EmailLayout>;
}
