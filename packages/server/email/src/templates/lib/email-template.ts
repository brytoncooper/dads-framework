import type { ReactElement } from "react";
import type { z } from "zod";

/**
 * What an email template IS: a name, a description an operator can read, the
 * props it needs, the subject and preview lines it computes from them, the
 * body it renders, and at least one sample that fills the whole thing in.
 *
 * Props are JSON-shaped on purpose — dates arrive as `z.iso.datetime()`
 * strings, ids as strings. A template's props are written to an outbox row as
 * jsonb and read back by a worker minutes later, so anything that cannot
 * survive `JSON.stringify` cannot be a prop.
 */

/**
 * `<domain>.<kebab-name>`, e.g. `identity.account-invitation`. The dot is the
 * owner: reading a template name tells you which library to open.
 */
export const EMAIL_TEMPLATE_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Long enough that "TODO" and "invite email" both fail. The description is
 * what an operator picking a template to test-send reads, and what the
 * preview gallery lists — a label they already understand is not enough.
 */
export const EMAIL_TEMPLATE_DESCRIPTION_MIN_LENGTH = 20;

/**
 * A declared email template.
 *
 * `TProps` is constrained to `z.ZodType` rather than `z.ZodObject` for the
 * same reason `LiveEnvironmentActionDefinition` is: object-ness is a REGISTRY
 * wall, thrown with the template's name attached, and a constraint here would
 * make that wall unreachable and untestable. `defineEmailTemplate` below is
 * the narrow door every template actually comes through.
 *
 * `subject`, `preview` and `body` are written as METHODS rather than arrow
 * properties so a definition over a specific props schema stays assignable to
 * the erased form a registry holds — method parameters are bivariant, arrow
 * properties are not.
 */
export type EmailTemplateDefinition<TProps extends z.ZodType> = {
  /** `<domain>.<kebab-name>`; unique across the registry. */
  readonly name: string;
  /** What this email says and when it is sent, for an operator. */
  readonly description: string;
  /** The props schema. Every field carries a `.meta({ description })`. */
  readonly props: TProps;
  subject(props: z.output<TProps>): string;
  /** The line an inbox shows beside the subject. Omit to show none. */
  preview?(props: z.output<TProps>): string;
  body(props: z.output<TProps>): ReactElement;
  /**
   * Named, complete prop sets — the preview gallery renders these, and
   * `email.send-test` sends one. At least one is required, and every one is
   * parsed at registration, so a sample that stopped matching its schema
   * fails at boot rather than in front of an operator.
   */
  readonly samples: Readonly<Record<string, z.input<TProps>>>;
};

/**
 * A definition with its props type erased — what a registry, a catalog, or a
 * preview route holds when it does not know which template it has. The props
 * schema is an object here, which is what the registry proved before storing
 * it.
 */
export type AnyEmailTemplateDefinition = EmailTemplateDefinition<z.ZodObject>;

/**
 * Declares a template. An identity function: it exists to bind `TProps` so
 * `subject`, `preview` and `body` receive parsed props with no annotation.
 *
 * Deliberately NOT the validation point — the registry is
 * (`email-template-registry.ts`), exactly as live-environment actions
 * validate at registration. A template file is imported by a barrel, and a
 * half-finished scaffold that threw on import would take the whole library
 * down instead of failing one boot check with a readable message.
 */
export function defineEmailTemplate<TProps extends z.ZodObject>(
  definition: EmailTemplateDefinition<TProps>,
): EmailTemplateDefinition<TProps> {
  return definition;
}
