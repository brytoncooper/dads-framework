/**
 * What this kit needs to know about a template, and nothing more.
 *
 * These are structural types on purpose: `@dads-framework/email/templates`
 * satisfies them without this kit importing it, so delivery and rendering
 * build, test and fail independently. Composition binds the real registry and
 * the real render function; a unit test binds two objects.
 */

/** One template, as delivery sees it: a name, a props parser, named samples. */
export type EmailTemplate = {
  readonly name: string;
  /** Validates props before they are stored; throws on props it refuses. */
  readonly props: { parse(value: unknown): unknown };
  /** Named sample props, so an operator can send a test without inventing data. */
  readonly samples: Readonly<Record<string, unknown>>;
};

/** Every template this process knows, looked up by the name stored on the row. */
export type EmailTemplateCatalog = {
  find(name: string): EmailTemplate | undefined;
};

/** The rendered halves of one message. Subject and both bodies, no envelope. */
export type RenderedEmailContent = {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
};

/** Turns a template plus its props into the message a driver can send. */
export type RenderEmailTemplate = (
  template: EmailTemplate,
  props: Record<string, unknown>,
) => Promise<RenderedEmailContent>;
