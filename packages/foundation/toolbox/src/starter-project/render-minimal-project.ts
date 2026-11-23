import { isRecord } from "../parse-guards.js";
import { kitStarterFiles } from "./kit-starter.generated.js";
import { renderMinimalDocsAndTestFiles } from "./minimal-project-docs-and-tests.js";
import { renderMinimalServerFiles } from "./minimal-project-server.js";
import { renderMinimalWebFiles } from "./minimal-project-web.js";
import { renderMinimalWorkbenchFiles } from "./minimal-project-workbench.js";
import type { StarterProjectFile } from "./render-starter-project.js";
import { renderStarterVerificationFiles, withStarterScriptsPackage } from "./render-starter-verification-files.js";

const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Explicit allowlist of shared framework files copied from the kit starter. */
const KEPT_BASE_PATHS = new Set<string>([
  ".agents/skills/add-domain/SKILL.md",
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "apps/web/actions.ts",
  "apps/web/auth-client.ts",
  "apps/web/styles.css",
  "assembly/LOCAL-DEV.md",
  "assembly/api-entrypoints.ts",
  "assembly/compose.yml",
  "assembly/config.ts",
  "assembly/copy/account-mail.ts",
  "assembly/dev-mail.ts",
  "assembly/dev.mjs",
  "assembly/install-local-dependencies.mjs",
  "assembly/local-mail-template.ts",
  "assembly/local-mail.ts",
  "assembly/local-services.ts",
  "assembly/local-state.mjs",
  "assembly/migrate.ts",
  "assembly/migrations.ts",
  "assembly/model.ts",
  "assembly/protected-write.ts",
  "assembly/read-local-mail.mjs",
  "dads.project.json",
  "domains/tenants/contract/index.ts",
  "domains/tenants/contract/wire.ts",
  "domains/tenants/copy/invitation-openapi.ts",
  "domains/tenants/server/invitation-routes.ts",
  "domains/tenants/server/routes.ts",
  "domains/tenants/web-client/index.ts",
  "index.html",
  "libraries/app-runtime/index.ts",
  "migrations/20261120080100_email_delivery.migration.ts",
  "migrations/support/feature-flags.ts",
  "package.json",
  "tests/local-stack.test.mjs",
  "tsconfig.json",
]);

const DROPPED_PACKAGES = new Set<string>(["domains-notes", "domains-support", "libraries-sign-in-options"]);

const DROPPED_DEPENDENCIES = new Set<string>(["@dads-framework/documents", "marked"]);

const DROPPED_COMPOSE_ENV_KEYS = [
  "DADS_ENTERPRISE_SSO_PROVIDERS:",
  "DADS_ENTERPRISE_SCIM:",
  "DADS_FEATURE_PREVIEW:",
  "DADS_ENTERPRISE_STAFF_IMPERSONATION:",
] as const;

/** Render the lean Dads app skeleton with full framework shape and zero example domains. */
export function renderMinimalProjectFiles(options: { readonly projectName: string }): readonly StarterProjectFile[] {
  if (!PROJECT_NAME_PATTERN.test(options.projectName)) {
    throw new Error("Dads project names must use lowercase letters, numbers, dots, dashes, or underscores.");
  }
  const overrides = new Map<string, StarterProjectFile>(
    [
      ...renderMinimalServerFiles(),
      ...renderMinimalWebFiles(),
      ...renderMinimalWorkbenchFiles(),
      ...renderMinimalDocsAndTestFiles(),
    ].map((file) => [file.path, file]),
  );
  const kept = kitStarterFiles
    .filter((file) => KEPT_BASE_PATHS.has(file.path) && !overrides.has(file.path))
    .map((file) => transformMinimalBaseFile(file, options.projectName));

  return [...kept, ...overrides.values(), ...renderStarterVerificationFiles()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function transformMinimalBaseFile(file: StarterProjectFile, projectName: string): StarterProjectFile {
  if (file.path === "package.json") {
    return {
      ...file,
      content: minimalPackageManifest(file.content, projectName),
    };
  }
  if (file.path === "dads.project.json") {
    return { ...file, content: minimalProjectManifest(file.content) };
  }
  if (file.path === "assembly/compose.yml") {
    return { ...file, content: minimalComposeFile(file.content) };
  }
  if (file.path === "assembly/LOCAL-DEV.md") {
    return { ...file, content: minimalLocalDevGuide(file.content) };
  }
  if (file.path === "domains/tenants/web-client/index.ts") {
    return { ...file, content: minimalTenantsWebClient(file.content) };
  }
  return file;
}

function minimalPackageManifest(content: string, projectName: string): string {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) {
    throw new Error("Starter package.json must be a JSON object.");
  }
  const scripts = omitKeys(parsed["scripts"], new Set(["examples:setup"]));
  const updatedScripts: Record<string, unknown> = {
    ...scripts,
    start: "node assembly/dev.mjs up",
    verify: "node scripts/verify.mjs",
    "verify:checks": "npm run check:boundaries && npm run typecheck && npm run build:web && npm test",
    "check:boundaries": "dad check boundaries",
    "hooks:install": "sh .githooks/install",
  };
  const next = {
    ...parsed,
    name: projectName,
    scripts: updatedScripts,
    dependencies: omitKeys(parsed["dependencies"], DROPPED_DEPENDENCIES),
    devDependencies: omitKeys(parsed["devDependencies"], DROPPED_DEPENDENCIES),
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

function minimalProjectManifest(content: string): string {
  const parsed: unknown = JSON.parse(withStarterScriptsPackage(content));
  if (!isRecord(parsed) || !Array.isArray(parsed["packages"])) {
    throw new Error("Starter dads.project.json must declare packages.");
  }
  const packages = parsed["packages"].filter(
    (entry) => isRecord(entry) && typeof entry["name"] === "string" && !DROPPED_PACKAGES.has(entry["name"]),
  );
  return `${JSON.stringify({ ...parsed, packages }, null, 2)}\n`;
}

function minimalComposeFile(content: string): string {
  return content
    .split("\n")
    .filter((line) => !DROPPED_COMPOSE_ENV_KEYS.some((key) => line.trimStart().startsWith(key)))
    .join("\n");
}

function minimalLocalDevGuide(content: string): string {
  const marker = "\n### Preview Notes export for a tenant member";
  const index = content.indexOf(marker);
  return index === -1 ? content : `${content.slice(0, index)}\n`;
}

function minimalTenantsWebClient(content: string): string {
  return content
    .split("\n")
    .filter((line) => !line.includes("./permissions.js"))
    .join("\n")
    .replace(/\n{3,}$/u, "\n");
}

function omitKeys(value: unknown, excluded: ReadonlySet<string>): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
}
