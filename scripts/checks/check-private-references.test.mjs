import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { URL, fileURLToPath } from "node:url";

import { loadPrivatePatterns, main, patterns, scanFiles } from "./check-private-references.mjs";

const demoHome = ["/", "Users", "/", "someone"].join("");

const scriptPath = fileURLToPath(new URL("./check-private-references.mjs", import.meta.url));

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "private-references-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixture(dir, relPath, content) {
  const absPath = join(dir, relPath);
  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, content);
  return { absPath, relPath };
}

const gitFixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

function createTempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "private-references-git-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir, env: gitFixtureEnv });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
    env: gitFixtureEnv,
  });
  execFileSync("git", ["config", "user.name", "Test User"], {
    cwd: dir,
    env: gitFixtureEnv,
  });
  return dir;
}

test("a clean file passes", () => {
  withTempDir((dir) => {
    const file = writeFixture(dir, "clean.ts", "export const value = 1;\n");

    const result = scanFiles([file], []);

    assert.equal(result.hits.length, 0);
    assert.equal(result.scannedCount, 1);
  });
});

test("a file containing a GitHub token fails with pattern id secret-github-token", () => {
  withTempDir((dir) => {
    const file = writeFixture(
      dir,
      "src/leak.ts",
      // Built from repeated characters so secret scanners see no entropy;
      // 24 characters satisfies this guard's pattern without matching a
      // real token shape.
      `const token = 'ghp_${"x".repeat(24)}';\n`,
    );
    const githubToken = patterns.find((pattern) => pattern.id === "secret-github-token");

    const result = scanFiles([file], []);

    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].id, githubToken.id);
    assert.equal(result.hits[0].path, "src/leak.ts");
    assert.equal(result.hits[0].line, 1);
  });
});

test("an allowlisted (path, pattern) is reported as allowed and does not fail", () => {
  withTempDir((dir) => {
    const file = writeFixture(dir, "src/example.ts", `// see ${demoHome}/project for context\n`);
    const allowlist = [
      {
        path: "src/example.ts",
        pattern: "local-machine-path",
        reason: "test fixture reference",
      },
    ];

    const result = scanFiles([file], allowlist);

    assert.equal(result.hits.length, 0);
    assert.deepEqual(result.allowed, [
      {
        path: "src/example.ts",
        id: "local-machine-path",
        reason: "test fixture reference",
      },
    ]);
  });
});

test("--paths on a plain directory finds a planted local-machine-path hit", () => {
  withTempDir((dir) => {
    writeFixture(dir, "notes.txt", `see ${demoHome}/project for details\n`);

    const result = main(["--paths", dir, "--root", dir]);

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /^notes\.txt:1: local-machine-path: see \/Users\/someone\/project for details$/m);
  });
});

test("a binary file (contains NUL) is skipped", () => {
  withTempDir((dir) => {
    const file = writeFixture(dir, "binary.dat", Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]));

    const result = scanFiles([file], []);

    assert.equal(result.hits.length, 0);
    assert.equal(result.scannedCount, 0);
  });
});

test("CLI: exits non-zero and lists the hit when run as a subprocess", () => {
  const dir = createTempGitRepo();
  try {
    writeFixture(dir, "notes.txt", `see ${demoHome}/project for details\n`);
    execFileSync("git", ["add", "-A"], { cwd: dir, env: gitFixtureEnv });

    const result = spawnSync(process.execPath, [scriptPath, "--root", dir], {
      encoding: "utf8",
      env: gitFixtureEnv,
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /local-machine-path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--paths honors the exported tree's own allowlist, not the --root one", () => {
  withTempDir((exported) => {
    withTempDir((unrelatedRoot) => {
      writeFixture(exported, "notes.txt", `see ${demoHome}/project\n`);
      mkdirSync(join(exported, "scripts", "checks"), { recursive: true });
      writeFixture(
        exported,
        "scripts/checks/private-references.allow.json",
        JSON.stringify([
          {
            path: "notes.txt",
            pattern: "local-machine-path",
            reason: "reviewed example",
          },
        ]),
      );

      const result = main(["--paths", exported, "--root", unrelatedRoot]);

      assert.equal(result.exitCode, 0);
      assert.match(result.output, /^allowed: notes\.txt: local-machine-path \(reviewed example\)$/m);
    });
  });
});

test("local policy matches only the configured files and redacts the content", () => {
  withTempDir((dir) => {
    writeFixture(
      dir,
      "scripts/checks/private-references.local.json",
      JSON.stringify([
        {
          id: "sample-name",
          regex: "Mock Finch",
          files: "\\.md$",
          reason: "a synthetic private name",
        },
      ]),
    );
    const files = [
      writeFixture(dir, "docs/notes.md", "Mock Finch lives here\n"),
      writeFixture(dir, "src/notes.ts", "Mock Finch lives here\n"),
    ];

    assert.deepEqual(scanFiles(files, [], loadPrivatePatterns(dir)).hits, [
      { path: "docs/notes.md", id: "sample-name", line: 1, text: "[redacted]" },
    ]);
  });
});

test("a malformed local pattern file throws a clear error", () => {
  withTempDir((dir) => {
    writeFixture(dir, "scripts/checks/private-references.local.json", JSON.stringify({ not: "an array" }));

    assert.throws(() => loadPrivatePatterns(dir), /private-references\.local\.json must contain a JSON array/);
  });
});

test("the scanner source contains no NUL bytes, so it never skips itself as binary", () => {
  assert.equal(readFileSync(scriptPath).includes(0), false);
});

test("private patterns flag synthetic product identifiers and leave generic words alone", () => {
  withTempDir((dir) => {
    const policy = writeFixture(
      dir,
      "policy.json",
      JSON.stringify([
        {
          id: "origin-package-scope",
          regex: "@mock-finch/",
          reason: "sample package scope",
        },
        {
          id: "origin-ticket-id",
          regex: "\\bMF-[0-9]+\\b",
          reason: "sample ticket prefix",
        },
        {
          id: "origin-source-path",
          regex: "libs/mock-finch/",
          reason: "sample source path",
        },
        {
          id: "origin-product-name",
          regex: "Mock Finch",
          flags: "i",
          reason: "sample name",
        },
        {
          id: "origin-service-domain",
          regex: "mock-finch\\.example",
          reason: "sample domain",
        },
      ]),
    );
    const file = writeFixture(
      dir,
      "packages/example/src/index.ts",
      [
        "// Run this command to generate a ticket report.",
        "// Copyright (c) 2026 Example Author",
        'import "@mock-finch/example";',
        "// See MF-90001.",
        "// Keep the old package at libs/mock-finch/example.",
        "// Replace the mock Finch fixture.",
        "// https://service.mock-finch.example/sample.png",
      ].join("\n"),
    );
    const { hits } = scanFiles([file], [], loadPrivatePatterns(dir, policy.absPath));
    assert.deepEqual(
      hits.map(({ line, id }) => [line, id]),
      [
        [3, "origin-package-scope"],
        [4, "origin-ticket-id"],
        [5, "origin-source-path"],
        [6, "origin-product-name"],
        [7, "origin-service-domain"],
      ],
    );
    assert.ok(hits.every(({ text }) => text === "[redacted]"));
  });
});

test("an exact legacy exception cannot mask another reference in the same file", () => {
  withTempDir((dir) => {
    const relPath = "packages/example/src/index.ts";
    const legacy = '// Recognize "@mock-finch/old-output".';
    const file = writeFixture(dir, relPath, legacy + '\nimport "@mock-finch/other";\n');
    const { hits, allowed } = scanFiles(
      [file],
      [
        {
          path: relPath,
          pattern: "origin-package-scope",
          reason: "recognizes old generated metadata",
          exactText: legacy,
        },
      ],
      [{ id: "origin-package-scope", regex: /@mock-finch\//, sensitive: true }],
    );
    assert.equal(allowed.length, 1);
    assert.deepEqual(
      hits.map(({ line }) => line),
      [2],
    );
  });
});

test("private filenames are rejected before decoding and their values are redacted", () => {
  withTempDir((dir) => {
    const policy = writeFixture(
      dir,
      "patterns.json",
      JSON.stringify([
        {
          id: "private-filename",
          regex: "mock-finch",
          scope: "path",
          reason: "sample filename",
        },
      ]),
    );
    const file = writeFixture(dir, "images/mock-finch.png", Buffer.from([0]));
    assert.deepEqual(scanFiles([file], [], loadPrivatePatterns(dir, policy.absPath)).hits, [
      {
        path: "[redacted path]",
        line: 1,
        id: "private-filename",
        text: "[redacted]",
      },
    ]);
  });
});

test("a published tree may not carry a checkout's local policy file", () => {
  withTempDir((dir) => {
    writeFixture(dir, "scripts/checks/private-references.local.json", "[]");
    const result = main(["--paths", dir, "--root", dir]);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /local-private-policy/);
  });
});

test("malformed regex errors do not expose private syntax", () => {
  withTempDir((dir) => {
    const policy = writeFixture(
      dir,
      "patterns.json",
      JSON.stringify([
        {
          id: "sample",
          regex: "(Mock Finch",
          reason: "sample malformed regex",
        },
      ]),
    );
    assert.throws(
      () => loadPrivatePatterns(dir, policy.absPath),
      (error) => error.message.includes('invalid "regex"') && !error.message.includes("Mock Finch"),
    );
  });
});

test("an exported tree is checked against a private file stored outside it", () => {
  withTempDir((dir) => {
    const exported = join(dir, "exported");
    writeFixture(exported, "package.js", "// Uses the sample codename Mock Finch.");
    const patternsPath = writeFixture(
      dir,
      "outside.json",
      JSON.stringify([
        {
          id: "codename",
          regex: "Mock Finch",
          reason: "sample private codename",
        },
      ]),
    ).absPath;

    const args = ["--root", exported, "--paths", exported, "--private-patterns"];
    const result = main([...args, patternsPath]);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /^package\.js:1: codename: \[redacted\]$/m);
    assert.doesNotMatch(result.output, /Mock Finch/);
    assert.throws(() => main([...args, join(dir, "missing.json")]), /requested private pattern file does not exist/);
  });
});

test("a symlink's stored target is scanned without reading the target file", () => {
  withTempDir((root) => {
    symlinkSync(demoHome + "/missing", join(root, "workspace"));
    const result = main(["--paths", root, "--root", root]);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /workspace:1: local-machine-path/);
  });
});

test("an explicitly requested empty private policy fails closed", () => {
  withTempDir((root) => {
    const policy = writeFixture(root, "policy.json", "[]");
    assert.throws(() => loadPrivatePatterns(root, policy.absPath), /must contain at least one pattern/);
  });
});
