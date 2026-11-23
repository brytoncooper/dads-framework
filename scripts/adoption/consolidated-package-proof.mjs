// Run these imports against the installed tarball so a workspace's hoisted
// providers cannot hide an eager import or an accidental required dependency.
const entries = new Map([
  [
    "@dads-framework/core",
    {
      subpaths: [
        "contract",
        "contract/testing",
        "errors",
        "errors/map-error-to-http-response",
        "runtime/clock",
        "runtime/diagnostics",
        "runtime/diagnostics/testing",
        "runtime/request-work",
        "runtime/request-work/testing",
        "plugin",
        "plugin/testing",
        "plugin/web",
        "event-bus",
        "audit-actor",
        "references",
      ],
      hasRoot: false,
    },
  ],
  ["@dads-framework/client", { subpaths: ["telemetry/core", "telemetry/testing"] }],
  ["@dads-framework/documents", { subpaths: ["csv"], hasRoot: false }],
  ["@dads-framework/email", { subpaths: ["core", "testing", "core/testing"] }],
  ["@dads-framework/feature-flags", { subpaths: ["contract", "testing"] }],
  ["@dads-framework/http", { subpaths: ["health", "telemetry/core", "telemetry/testing"] }],
  ["@dads-framework/identity", { subpaths: ["scim", "testing", "impersonation"] }],
  ["@dads-framework/job-queue", { subpaths: ["core", "testing", "core/testing", "core/provider"] }],
  ["@dads-framework/object-storage", { subpaths: ["core", "testing"] }],
  ["@dads-framework/testing", { subpaths: ["nx", "path-aliases"] }],
]);

const absentProviders = new Map([
  ["@dads-framework/client", ["@sentry/react"]],
  ["@dads-framework/documents", ["pdfmake", "pdfjs-dist", "@napi-rs/canvas", "exceljs"]],
  ["@dads-framework/email", ["resend", "@react-email/render", "@dads-framework/postgres", "@dads-framework/job-queue"]],
  ["@dads-framework/feature-flags", ["@dads-framework/http", "@dads-framework/postgres", "react"]],
  ["@dads-framework/http", ["@opentelemetry/sdk-node"]],
  ["@dads-framework/identity", ["better-auth", "@dads-framework/postgres", "drizzle-orm"]],
  ["@dads-framework/job-queue", ["bullmq"]],
  [
    "@dads-framework/object-storage",
    ["@aws-sdk/client-s3", "@aws-sdk/cloudfront-signer", "@aws-sdk/s3-request-presigner"],
  ],
  ["@dads-framework/testing", ["nx", "vite"]],
]);

export function consolidatedPackageProof(packageName) {
  const entry = entries.get(packageName);
  if (!entry) return undefined;
  const specifiers = entry.subpaths.map((subpath) => `${packageName}/${subpath}`);
  if (entry.hasRoot !== false) specifiers.unshift(packageName);
  return `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    const specifiers = ${JSON.stringify(specifiers)};
    const resolveFromInstalledPackage = createRequire(import.meta.resolve(specifiers[0]));
    for (const provider of ${JSON.stringify(absentProviders.get(packageName) ?? [])}) {
      assert.throws(() => resolveFromInstalledPackage.resolve(provider), { code: "MODULE_NOT_FOUND" });
    }
    for (const specifier of specifiers) await import(specifier);
  `;
}
