export const V03_TARGET_VERSION = "0.3.0";

/** Every 0.1.x / 0.2.x package name consolidated in 0.3.0, mapped to its new package. */
export const RETIRED_PACKAGE_TO_TARGET: Readonly<Record<string, string>> = {
  "@dads-framework/audit-actor": "@dads-framework/core",
  "@dads-framework/authorization": "@dads-framework/spicedb-access",
  "@dads-framework/authorization-migration": "@dads-framework/spicedb-access",
  "@dads-framework/client-feature-flags": "@dads-framework/feature-flags",
  "@dads-framework/client-request-transport": "@dads-framework/client",
  "@dads-framework/client-telemetry": "@dads-framework/client",
  "@dads-framework/client-xlsx": "@dads-framework/documents",
  "@dads-framework/contract": "@dads-framework/core",
  "@dads-framework/copy": "@dads-framework/ui",
  "@dads-framework/cross-domain-references": "@dads-framework/core",
  "@dads-framework/csv": "@dads-framework/documents",
  "@dads-framework/design-tokens": "@dads-framework/ui",
  "@dads-framework/dev": "@dads-framework/toolbox",
  "@dads-framework/email-delivery": "@dads-framework/email",
  "@dads-framework/email-sender": "@dads-framework/email",
  "@dads-framework/email-templates": "@dads-framework/email",
  "@dads-framework/errors": "@dads-framework/core",
  "@dads-framework/event-bus": "@dads-framework/core",
  "@dads-framework/identity-better-auth": "@dads-framework/identity",
  "@dads-framework/migrations": "@dads-framework/postgres",
  "@dads-framework/path-aliases": "@dads-framework/testing",
  "@dads-framework/pdf": "@dads-framework/documents",
  "@dads-framework/plugin": "@dads-framework/core",
  "@dads-framework/runtime": "@dads-framework/core",
  "@dads-framework/styles": "@dads-framework/ui",
  "@dads-framework/telemetry": "@dads-framework/http",
  "@dads-framework/tenants": "@dads-framework/identity",
  "@dads-framework/testing-vitest": "@dads-framework/testing",
};

type SpecifierRule = {
  readonly from: string;
  readonly to: string;
  readonly exactOnly?: boolean;
};

/**
 * Longest-prefix-first import specifier rewrites from 0.1.x / 0.2.x to 0.3.0.
 * Exact entries take precedence before subpath-forwarding prefix entries.
 */
const SPECIFIER_RULES: readonly SpecifierRule[] = [
  {
    from: "@dads-framework/design-tokens/default.tokens.json",
    to: "@dads-framework/ui/tokens/default.tokens.json",
    exactOnly: true,
  },
  {
    from: "@dads-framework/styles",
    to: "@dads-framework/ui/styles/index.css",
    exactOnly: true,
  },
  {
    from: "@dads-framework/authorization-migration",
    to: "@dads-framework/spicedb-access/migration",
  },
  {
    from: "@dads-framework/client-request-transport",
    to: "@dads-framework/client",
  },
  {
    from: "@dads-framework/cross-domain-references",
    to: "@dads-framework/core/references",
  },
  {
    from: "@dads-framework/client-feature-flags",
    to: "@dads-framework/feature-flags/react",
  },
  {
    from: "@dads-framework/identity-better-auth",
    to: "@dads-framework/identity/better-auth",
  },
  {
    from: "@dads-framework/client-telemetry",
    to: "@dads-framework/client/telemetry",
  },
  {
    from: "@dads-framework/email-templates",
    to: "@dads-framework/email/templates",
  },
  {
    from: "@dads-framework/email-delivery",
    to: "@dads-framework/email/delivery",
  },
  {
    from: "@dads-framework/testing-vitest",
    to: "@dads-framework/testing/vitest",
  },
  {
    from: "@dads-framework/authorization",
    to: "@dads-framework/spicedb-access",
  },
  {
    from: "@dads-framework/design-tokens",
    to: "@dads-framework/ui/tokens",
  },
  {
    from: "@dads-framework/email-sender",
    to: "@dads-framework/email",
  },
  {
    from: "@dads-framework/path-aliases",
    to: "@dads-framework/testing/path-aliases",
  },
  {
    from: "@dads-framework/audit-actor",
    to: "@dads-framework/core/audit-actor",
  },
  {
    from: "@dads-framework/client-xlsx",
    to: "@dads-framework/documents/xlsx",
  },
  {
    from: "@dads-framework/migrations",
    to: "@dads-framework/postgres/migrations",
  },
  {
    from: "@dads-framework/event-bus",
    to: "@dads-framework/core/event-bus",
  },
  {
    from: "@dads-framework/telemetry",
    to: "@dads-framework/http/telemetry",
  },
  {
    from: "@dads-framework/contract",
    to: "@dads-framework/core/contract",
  },
  {
    from: "@dads-framework/runtime",
    to: "@dads-framework/core/runtime",
  },
  {
    from: "@dads-framework/tenants",
    to: "@dads-framework/identity/tenants",
  },
  {
    from: "@dads-framework/errors",
    to: "@dads-framework/core/errors",
  },
  {
    from: "@dads-framework/plugin",
    to: "@dads-framework/core/plugin",
  },
  {
    from: "@dads-framework/styles",
    to: "@dads-framework/ui/styles",
  },
  {
    from: "@dads-framework/copy",
    to: "@dads-framework/ui/copy",
  },
  {
    from: "@dads-framework/csv",
    to: "@dads-framework/documents/csv",
  },
  {
    from: "@dads-framework/dev",
    to: "@dads-framework/toolbox/dev",
  },
  {
    from: "@dads-framework/pdf",
    to: "@dads-framework/documents/pdf",
  },
];

/**
 * Dependencies that were required in 0.2.x packages and became optional peers
 * on their consolidated 0.3.0 parent so lightweight adopters do not pull them.
 */
export const PEERS_FOR_RETIRED_PACKAGE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "@dads-framework/identity-better-auth": {
    "@better-auth/core": "1.7.26",
    "@better-auth/sso": "1.7.26",
    "better-auth": "1.7.26",
    kysely: "0.28.17",
  },
  "@dads-framework/email-templates": {
    "@react-email/components": "^1.0.12",
    "@react-email/render": "^2.1.0",
  },
  "@dads-framework/pdf": {
    pdfmake: "^0.3.11",
  },
  "@dads-framework/client-xlsx": {
    exceljs: "^4.4.0",
  },
  "@dads-framework/telemetry": {
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/exporter-trace-otlp-proto": "^0.222.0",
    "@opentelemetry/instrumentation": "^0.222.0",
    "@opentelemetry/instrumentation-http": "^0.222.0",
    "@opentelemetry/instrumentation-pg": "^0.74.0",
    "@opentelemetry/resources": "^2.11.0",
    "@opentelemetry/sdk-node": "^0.222.0",
    "@opentelemetry/sdk-trace": "^2.11.0",
  },
};

/** Rewrites a single 0.1.x / 0.2.x module specifier to its 0.3.0 equivalent. */
export function rewriteV03ImportSpecifier(specifier: string): string {
  for (const rule of SPECIFIER_RULES) {
    if (specifier === rule.from) return rule.to;
    if (rule.exactOnly !== true && specifier.startsWith(`${rule.from}/`)) {
      return `${rule.to}${specifier.slice(rule.from.length)}`;
    }
  }
  return specifier;
}
