import { z } from "zod";
import type { EmailBranding } from "./email-branding.js";
import {
  EMAIL_TEMPLATE_DESCRIPTION_MIN_LENGTH,
  EMAIL_TEMPLATE_NAME_PATTERN,
  type AnyEmailTemplateDefinition,
  type EmailTemplateDefinition,
} from "./email-template.js";
import { renderEmailTemplate, type RenderedEmail } from "./render-email-template.js";

/**
 * The collection of declared email templates. The composition root builds it at
 * boot from what the domains returned, and registration is the enforcement
 * point. A malformed name, a description nobody could act on, a props schema
 * that is not an object, a template with no sample, a sample that no longer
 * matches its schema, a duplicate name — all throw at BOOT, where an operator
 * is not waiting, rather than at send time, where one is.
 *
 * Registration never RENDERS. A render is React plus two passes over the
 * document; doing it for every template at every boot would make the API
 * start slower for a check the sample parse already makes.
 */

/** JSON Schema comes back record-shaped without a type assertion. */
const jsonSchemaSchema = z.record(z.string(), z.unknown());

/**
 * A registered template as the preview gallery and the delivery catalog read
 * it: the metadata, the JSON Schema a form or a doc page renders from, the
 * definition itself for a caller that knows what it holds, and `renderSample`
 * for the gallery.
 */
export type RegisteredEmailTemplate = {
  readonly name: string;
  readonly description: string;
  /** Sample names, sorted, for a gallery's sample buttons. */
  readonly sampleNames: readonly string[];
  /** Generated from the props schema — never hand-written. */
  readonly propsJsonSchema: Record<string, unknown>;
  readonly definition: AnyEmailTemplateDefinition;
  /** The named sample rendered, or `undefined` when there is no such sample. */
  renderSample(sample: string): Promise<RenderedEmail> | undefined;
};

export class EmailTemplateRegistry {
  private readonly templates = new Map<string, RegisteredEmailTemplate>();

  constructor(private readonly branding?: EmailBranding) {}

  register(definition: EmailTemplateDefinition<z.ZodType>): void {
    assertUsableName(definition);
    assertUsableDescription(definition);
    assertObjectProps(definition);
    assertSamplesParse(definition);
    if (this.templates.has(definition.name)) {
      throw new Error(
        `Email template "${definition.name}" is already registered — names are unique across the registry`,
      );
    }

    this.templates.set(definition.name, {
      name: definition.name,
      description: definition.description,
      sampleNames: Object.keys(definition.samples).sort(),
      propsJsonSchema: jsonSchemaSchema.parse(z.toJSONSchema(definition.props)),
      definition,
      renderSample: (sample) => {
        const props = definition.samples[sample];
        if (props === undefined) return undefined;
        return renderEmailTemplate(definition, props, this.branding);
      },
    });
  }

  find(name: string): RegisteredEmailTemplate | undefined {
    return this.templates.get(name);
  }

  /** Every registered template, sorted by name for a stable gallery. */
  list(): readonly RegisteredEmailTemplate[] {
    return [...this.templates.values()].sort((first, second) => first.name.localeCompare(second.name));
  }
}

/** Builds the registry the composition root hands around. */
export function createEmailTemplateRegistry(
  definitions: readonly AnyEmailTemplateDefinition[],
  branding?: EmailBranding,
): EmailTemplateRegistry {
  const registry = new EmailTemplateRegistry(branding);
  for (const definition of definitions) registry.register(definition);
  return registry;
}

function assertUsableName(definition: EmailTemplateDefinition<z.ZodType>): void {
  if (!EMAIL_TEMPLATE_NAME_PATTERN.test(definition.name)) {
    throw new Error(
      `Email template name "${definition.name}" is not <domain>.<kebab-name> — e.g. "identity.account-invitation"`,
    );
  }
}

function assertUsableDescription(definition: EmailTemplateDefinition<z.ZodType>): void {
  const length = definition.description.trim().length;
  if (length < EMAIL_TEMPLATE_DESCRIPTION_MIN_LENGTH) {
    throw new Error(
      `Email template "${definition.name}" needs a description of at least ${EMAIL_TEMPLATE_DESCRIPTION_MIN_LENGTH} characters — say what it tells the reader and when it is sent`,
    );
  }
}

/**
 * The object wall, and the point where the erased definition becomes the one
 * the registry stores: everything downstream — samples, outbox rows, the
 * preview form — is keyed by field, so a props schema without fields has
 * nothing for them to key on.
 */
function assertObjectProps(
  definition: EmailTemplateDefinition<z.ZodType>,
): asserts definition is AnyEmailTemplateDefinition {
  if (!(definition.props instanceof z.ZodObject)) {
    throw new Error(
      `Email template "${definition.name}" must declare an object props schema — samples, outbox rows and the preview form are all keyed by field`,
    );
  }
}

/**
 * Every sample is parsed here, so "the props changed and the sample did not"
 * is a boot failure with the field named, not a broken preview page.
 */
function assertSamplesParse(definition: EmailTemplateDefinition<z.ZodType>): void {
  const sampleNames = Object.keys(definition.samples);
  if (sampleNames.length === 0) {
    throw new Error(
      `Email template "${definition.name}" declares no samples — the preview gallery and the test send both need one complete set of props`,
    );
  }
  for (const sampleName of sampleNames) {
    const parsed = definition.props.safeParse(definition.samples[sampleName]);
    if (!parsed.success) {
      throw new Error(
        `Email template "${definition.name}" sample "${sampleName}" does not match its props schema: ${z.prettifyError(parsed.error)}`,
      );
    }
  }
}
