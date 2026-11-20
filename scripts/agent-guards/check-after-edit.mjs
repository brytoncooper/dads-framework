#!/usr/bin/env node
/**
 * Agent guard: every agent edit is formatted, linted, and measured at once.
 *
 * Runs as a post-tool-use hook in Claude Code (`.claude/settings.json`,
 * matcher `Edit|Write|MultiEdit`) and Cursor (`.cursor/hooks.json`,
 * `afterFileEdit`). It takes the one file that just changed and runs the
 * cheap part of the gate on it: the mechanical fixes are applied silently,
 * and whatever is left is handed straight back to the agent while the code
 * is still in its head, instead of surfacing an hour later in CI.
 *
 *   .ts .tsx .mts .cts .js .jsx .mjs .cjs  eslint --fix, then the ratchet
 *   .rs                                    rustfmt, then the ratchet
 *   .md                                    prettier --write
 *
 * A missing tool fails open — an unbootstrapped checkout must not wedge every
 * edit, and the hooks and CI are still the wall. Unreadable hook input fails
 * closed, because then the guard cannot know what it just let through.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUDGETS = "scripts/checks/check-source-budgets.mjs";
const MAX_REPORTED_LINES = 20;

const LINTED = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const RUST = /\.rs$/;
const MARKDOWN = /\.md$/;

/**
 * The steps for one file, in order. `binary` is the local executable whose
 * absence means "tool not installed here" (fail open); `stream` says where
 * that step reports the violations worth repeating.
 */
export function planFor(path) {
  if (LINTED.test(path)) {
    return [
      {
        name: "eslint",
        command: "npx",
        args: [
          "--no-install",
          "eslint",
          "--fix",
          "--no-warn-ignored",
          "--format",
          "compact",
          path,
        ],
        binary: "node_modules/.bin/eslint",
        stream: "stdout",
      },
      budgetStep(path),
    ];
  }
  if (RUST.test(path)) {
    return [
      {
        name: "rustfmt",
        command: "rustfmt",
        args: ["--edition", "2024", path],
        binary: null,
        stream: "stderr",
      },
      budgetStep(path),
    ];
  }
  if (MARKDOWN.test(path)) {
    return [
      {
        name: "prettier",
        command: "npx",
        args: ["--no-install", "prettier", "--write", path],
        binary: "node_modules/.bin/prettier",
        stream: "stderr",
      },
    ];
  }
  return [];
}

function budgetStep(path) {
  return {
    name: "check-source-budgets",
    command: "node",
    args: [BUDGETS, "--file", path, "--update"],
    binary: BUDGETS,
    stream: "both",
  };
}

/** The message handed back to the agent, capped at 20 lines per step. */
export function renderReason(path, failures) {
  const blocks = failures.map((failure) => {
    const lines = failure.output.trim().split("\n");
    const shown = lines.slice(0, MAX_REPORTED_LINES).join("\n");
    const elided =
      lines.length > MAX_REPORTED_LINES
        ? `\n… ${String(lines.length - MAX_REPORTED_LINES)} more lines`
        : "";
    return `${failure.name}:\n${shown}${elided}`;
  });
  return `${path} still fails after the automatic fixes — fix this before moving on:\n${blocks.join("\n\n")}`;
}

/** Claude Code and Cursor want the same correction in two different shapes. */
export function renderResponse(event, reason) {
  const isClaude =
    event !== null &&
    typeof event === "object" &&
    typeof event.hook_event_name === "string";
  if (isClaude) return JSON.stringify({ decision: "block", reason });
  return JSON.stringify({ agentMessage: reason, agent_message: reason });
}

/** The path this event edited, in either harness's shape, or `null`. */
export function pathOf(event) {
  if (event === null || typeof event !== "object") return null;
  const toolInput = event.tool_input ?? event.toolInput ?? {};
  const candidates = [
    event.file_path,
    event.filePath,
    toolInput.file_path,
    toolInput.filePath,
    toolInput.path,
  ];
  return candidates.find((value) => typeof value === "string") ?? null;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

const SELF_TEST_CASES = [
  ["packages/server/http/src/index.ts", ["eslint", "check-source-budgets"]],
  [
    "scripts/agent-guards/check-after-edit.mjs",
    ["eslint", "check-source-budgets"],
  ],
  ["vitest.config.js", ["eslint", "check-source-budgets"]],
  ["apps/workbench/src/app.tsx", ["eslint", "check-source-budgets"]],
  ["crates/dads-testing-core/src/lib.rs", ["rustfmt", "check-source-budgets"]],
  ["docs/house-rules.md", ["prettier"]],
  ["package.json", []],
  ["fixtures/testing-soundness/cases.json", []],
  ["Cargo.lock", []],
];

function selfTest() {
  const failures = [];
  for (const [path, expected] of SELF_TEST_CASES) {
    const actual = planFor(path).map((step) => step.name);
    if (actual.join(",") !== expected.join(",")) {
      failures.push(
        `${path} -> [${actual.join(",")}], want [${expected.join(",")}]`,
      );
    }
  }
  const long = Array.from(
    { length: 30 },
    (_, index) => `line ${String(index)}`,
  );
  const reason = renderReason("a.ts", [
    { name: "eslint", output: long.join("\n") },
  ]);
  if (!reason.includes("… 10 more lines") || reason.includes("line 20")) {
    failures.push("output must be capped at 20 lines");
  }
  if (pathOf(null) !== null)
    failures.push("malformed input must yield no path");
  const total = SELF_TEST_CASES.length + 2;
  const lines = failures.map((failure) => `self-test FAIL ${failure}\n`);
  process.stdout.write(
    failures.length === 0
      ? `check-after-edit self-test OK (${String(total)} cases)\n`
      : lines.join("") +
          `check-after-edit self-test: ${String(failures.length)} of ${String(total)} failed\n`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

function readEvent() {
  try {
    const parsed = JSON.parse(readFileSync(0, "utf8"));
    return typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** The repository-relative path, or `null` when the file is outside it. */
function repositoryPath(raw) {
  const absolute = isAbsolute(raw) ? raw : resolve(ROOT, raw);
  const inside = relative(ROOT, absolute);
  if (inside === "" || inside.startsWith("..")) return null;
  return inside.split("\\").join("/");
}

function runStep(step) {
  if (step.binary !== null && !existsSync(join(ROOT, step.binary))) return null;
  const result = spawnSync(step.command, step.args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error !== undefined) return null;
  if (result.status === 0) return null;
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const output =
    step.stream === "stdout"
      ? stdout
      : step.stream === "stderr"
        ? stderr
        : [stdout, stderr].filter((text) => text !== "").join("\n");
  if (output === "") return null;
  return { name: step.name, output };
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const event = readEvent();
  if (event === null) {
    const reason =
      "The after-edit guard could not read its hook input, so the edit was never linted or measured. Run `npm run verify` before trusting it.";
    process.stdout.write(renderResponse(event, reason));
  } else {
    const raw = pathOf(event);
    const path = raw === null ? null : repositoryPath(raw);
    const failures = [];
    if (path !== null && existsSync(join(ROOT, path))) {
      for (const step of planFor(path)) {
        const failure = runStep(step);
        if (failure !== null) failures.push(failure);
      }
    }
    process.stdout.write(
      failures.length === 0
        ? "{}"
        : renderResponse(event, renderReason(path, failures)),
    );
  }
}
