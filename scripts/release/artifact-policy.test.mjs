import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { auditPackage } from "./artifact-policy.mjs";

const notice = Buffer.from("MIT License\nCopyright (c) 2026 Bryton Cooper\n");

function packageFixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "dads-release-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return { root, entries: Object.keys(files).map((path) => ({ path })) };
}

test("approved MIT notice and declared exports pass", (t) => {
  const { root, entries } = packageFixture(t, {
    "LICENSE.md": notice,
    "package.json": JSON.stringify({ exports: { ".": "./dist/index.js" } }),
    "dist/index.js": 'export const label = "Run this command";',
  });
  assert.deepEqual(auditPackage(root, entries, notice, []), []);
});

test("immutable migrations fail while match contents remain unreported", (t) => {
  const { root, entries } = packageFixture(t, {
    "LICENSE.md": notice,
    "package.json": "{}",
    "src/lib/migrations/legacy.migration.ts": 'const column = "mock_finch_id";',
    "dist/lib/migrations/legacy.migration.js": 'const column = "impersonation_id";',
    "dist/probe.js": "// Sample private rule match: Mock Finch.",
  });
  const findings = auditPackage(root, entries, notice, [
    { id: "sample-private-marker", regex: /Mock Finch/g },
    {
      id: "sample-migration-column",
      regex: /mock_finch_id/,
      filesPattern: /migrations/,
    },
  ]);
  assert.deepEqual(findings, [
    ["private-pattern", 2],
    ["protected-historical-migration", 1],
  ]);
  assert.doesNotMatch(JSON.stringify(findings), /Mock Finch/);
});

test("missing notices, held-back endpoints and absent exports refuse the archive", (t) => {
  const { root, entries } = packageFixture(t, {
    "package.json": JSON.stringify({ bin: { dad: "./dist/cli.js" } }),
    "dist/routes.js": 'export const route = { path: "/api/flags/preview" };',
  });
  assert.deepEqual(auditPackage(root, entries, notice, []), [
    ["held-back-route-or-plugin", 1],
    ["missing-mit-notice", 1],
    ["missing-package-entrypoint", 1],
  ]);
});

test("private wire labels and filenames block otherwise valid packages", (t) => {
  const { root, entries } = packageFixture(t, {
    "LICENSE.md": notice,
    "package.json": "{}",
    "dist/index.js": 'export const metadataSheet = "_Mock Finch Metadata";',
    "dist/mock-finch.png": Buffer.from([0]),
  });
  const findings = auditPackage(root, entries, notice, [
    { id: "sample-wire-label", regex: /Mock Finch/ },
    { id: "sample-path", regex: /mock-finch/, scope: "path" },
  ]);
  assert.deepEqual(findings, [["private-pattern", 2]]);
  assert.doesNotMatch(JSON.stringify(findings), /mock.finch/i);
});

test("a retained held-back declaration blocks the entire packed candidate", (t) => {
  const { root, entries } = packageFixture(t, {
    "LICENSE.md": notice,
    "package.json": "{}",
    "dist/index.d.ts": "export type SubjectImpersonation = { readonly id: string };",
  });
  assert.deepEqual(auditPackage(root, entries, notice, []), [["held-back-api-surface", 1]]);
});
