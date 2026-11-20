// Run these imports against the installed tarball so a workspace's hoisted
// providers cannot hide an eager import or an accidental required dependency.
const entries = new Map([
  ["@dads-framework/client-telemetry", { subpaths: ["core"] }],
  [
    "@dads-framework/email-sender",
    { subpaths: ["core", "testing", "core/testing"] },
  ],
  ["@dads-framework/feature-flags", { subpaths: ["contract", "testing"] }],
  ["@dads-framework/http", { subpaths: ["health"] }],
  [
    "@dads-framework/job-queue",
    { subpaths: ["core", "testing", "core/testing", "core/provider"] },
  ],
  ["@dads-framework/object-storage", { subpaths: ["core", "testing"] }],
  [
    "@dads-framework/runtime",
    {
      subpaths: [
        "clock",
        "diagnostics",
        "diagnostics/testing",
        "request-work",
        "request-work/testing",
      ],
      hasRoot: false,
    },
  ],
  ["@dads-framework/telemetry", { subpaths: ["core", "testing"] }],
  ["@dads-framework/testing", { subpaths: ["nx"] }],
]);

const absentProviders = new Map([
  ["@dads-framework/client-telemetry", ["@sentry/react"]],
  ["@dads-framework/email-sender", ["resend"]],
  [
    "@dads-framework/feature-flags",
    ["@dads-framework/http", "@dads-framework/postgres"],
  ],
  ["@dads-framework/job-queue", ["bullmq"]],
  [
    "@dads-framework/object-storage",
    [
      "@aws-sdk/client-s3",
      "@aws-sdk/cloudfront-signer",
      "@aws-sdk/s3-request-presigner",
    ],
  ],
  ["@dads-framework/telemetry", ["@opentelemetry/sdk-node"]],
  ["@dads-framework/testing", ["nx"]],
]);

export function consolidatedPackageProof(packageName) {
  const entry = entries.get(packageName);
  if (!entry) return undefined;
  const specifiers = entry.subpaths.map(
    (subpath) => `${packageName}/${subpath}`,
  );
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
