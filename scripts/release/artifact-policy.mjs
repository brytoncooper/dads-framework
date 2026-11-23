import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";
import { matchesPattern, patterns } from "../checks/check-private-references.mjs";

const privatePath =
  /(?:^|\/)(?:\.git|\.dads|docs\/private|testing-evidence|\.agents\/plans|\.cursor\/agent-friction)(?:\/|$)|(?:^|\/)(?:dad2\.md|\.env(?:\.(?!example$)[^/]+)?)$|\.validation\.zed\.yaml$/i;
const retiredAuditShape = /\bimpersonation_(?:id|started_at|ended_at)\b/i;
const paidRouteOrPlugin =
  /(?:\b(?:sso|scim|saml|oidc)Plugin\s*\(|(?:path|route)\s*:\s*["'`][^"'`]*(?:\/(?:impersonate(?:-user)?|stop-impersonating|impersonation|scim|saml|sso|permissions-dashboard)(?:[/? "'`]|$)|\/audit(?:[-a-z]*)\/export|\/(?:feature-)?flags?\/preview))/i;
const heldBackSurface =
  /\b(?:SubjectImpersonation|excludeImpersonated|impersonation_id|startImpersonation|stopImpersonating|previewFeatureFlag|flagPreview|enableFlagPreview|companySso|permissionsDashboard|exportAuditLog)\b/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function inspectFile(path, bytes, privatePatterns) {
  if (privatePath.test(path)) return "private-artifact-path";
  const pathRule = patterns.find((rule) => rule.scope === "path" && matchesPattern(rule, path, path));
  if (pathRule) return pathRule.id;
  if (privatePatterns.some((rule) => rule.scope === "path" && matchesPattern(rule, path, path))) {
    return "private-pattern";
  }
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    return "unreviewed-binary";
  }
  if (/(?:^|\/)migrations?(?:\/|$)/i.test(path) && retiredAuditShape.test(text)) {
    return "protected-historical-migration";
  }
  if (paidRouteOrPlugin.test(text)) return "held-back-route-or-plugin";
  if (heldBackSurface.test(text)) return "held-back-api-surface";
  if (privatePatterns.some((rule) => rule.scope !== "path" && matchesPattern(rule, path, text))) {
    return "private-pattern";
  }
  return patterns.find((rule) => rule.scope !== "path" && matchesPattern(rule, path, text))?.id;
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

function declaredTargetsPresent(root, entries) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const targets = [
    manifest.main,
    manifest.module,
    manifest.types,
    manifest.style,
    ...exportTargets(manifest.bin),
    ...exportTargets(manifest.exports),
  ].filter((target) => typeof target === "string");
  const present = new Set(entries.map(({ path }) => path));
  return targets.every((target) => {
    const path = target.replace(/^\.\//, "");
    if (!path.includes("*")) return present.has(path);
    const parts = path.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const match = new RegExp(`^${parts.join(".+")}$`);
    return [...present].some((file) => match.test(file));
  });
}

export function auditPackage(root, entries, approvedLicense, privatePatterns, approvedNativeExecutable) {
  const found = new Map();
  const expected = new Set(entries.map(({ path }) => path));
  for (const entry of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isDirectory()) continue;
    const file = join(entry.parentPath, entry.name);
    const path = relative(root, file).split(sep).join("/");
    if (!entry.isFile() || !expected.delete(path)) {
      found.set("unexpected-packed-content", (found.get("unexpected-packed-content") ?? 0) + 1);
      continue;
    }
    const bytes = readFileSync(file);
    const rule =
      path === "LICENSE.md"
        ? bytes.equals(approvedLicense)
          ? undefined
          : "mit-notice-mismatch"
        : path === approvedNativeExecutable
          ? undefined
          : inspectFile(path, bytes, privatePatterns);
    if (rule) found.set(rule, (found.get(rule) ?? 0) + 1);
  }
  if (expected.size > 0) found.set("missing-packed-content", expected.size);
  if (!entries.some((entry) => entry.path === "LICENSE.md")) found.set("missing-mit-notice", 1);
  if (!declaredTargetsPresent(root, entries)) found.set("missing-package-entrypoint", 1);
  return [...found.entries()].sort(([left], [right]) => left.localeCompare(right));
}
