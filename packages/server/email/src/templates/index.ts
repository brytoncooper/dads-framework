/**
 * The email rendering kit's public surface: the way a template is declared,
 * the brand and components it is built from, the function that renders it,
 * and the registry the composition root builds once at boot. Templates
 * themselves belong to the domain that owns the words, and import this barrel.
 */
export {
  defineEmailTemplate,
  EMAIL_TEMPLATE_DESCRIPTION_MIN_LENGTH,
  EMAIL_TEMPLATE_NAME_PATTERN,
  type AnyEmailTemplateDefinition,
  type EmailTemplateDefinition,
} from "./lib/email-template.js";
export {
  createEmailTemplateRenderer,
  renderEmailTemplate,
  type EmailTemplateRenderer,
  type RenderedEmail,
} from "./lib/render-email-template.js";
export {
  createEmailTemplateRegistry,
  EmailTemplateRegistry,
  type RegisteredEmailTemplate,
} from "./lib/email-template-registry.js";
export { componentShowcaseEmailTemplate } from "./lib/component-showcase.email-template.js";
export type { EmailBranding, EmailLogo } from "./lib/email-branding.js";
export { emailTheme, type EmailTheme } from "./lib/email-theme.js";
export {
  EmailLayout,
  type EmailLayoutProps,
} from "./lib/components/email-layout.js";
export {
  EmailButton,
  type EmailButtonProps,
} from "./lib/components/email-button.js";
export {
  EmailDataTable,
  type EmailDataFact,
  type EmailDataTableProps,
} from "./lib/components/email-data-table.js";
export {
  EmailBadge,
  type EmailBadgeProps,
  type EmailBadgeTone,
} from "./lib/components/email-badge.js";
export { EmailCode, type EmailCodeProps } from "./lib/components/email-code.js";
export {
  EmailHeading,
  type EmailHeadingProps,
} from "./lib/components/email-heading.js";
export { EmailLink, type EmailLinkProps } from "./lib/components/email-link.js";
export {
  EmailFinePrint,
  EmailText,
  type EmailTextProps,
} from "./lib/components/email-text.js";
export type { EmailDocumentRenderer } from "./lib/email-document-renderer.js";
