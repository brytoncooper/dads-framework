#!/usr/bin/env node
/**
 * Agent guard: editing a protected file asks the user first.
 *
 * Runs as a pre-tool-use hook in Claude Code (`.claude/settings.json`) and
 * Cursor (`.cursor/hooks.json`). It reads the hook event on stdin, pulls out
 * the paths the tool wants to write, and answers `ask` when one of them is a
 * file the house rules put under the user's hand: the compiler and lint
 * configuration, the ratchet baseline, the hooks and guards themselves, the
 * workflow, the contract documents, the licence. Everything else is allowed.
 *
 * The list is the wall around the walls. An agent that can quietly rewrite
 * `eslint.config.js` or `.agents/source-budgets.json` has no gates at all, so
 * those edits stop and wait for a person. There is no standing-approval file
 * in this version: the answer is always a live question.
 *
 * Malformed input fails closed (ask). `--self-test` proves the matrix.
 */
import { readFileSync } from "node:fs";
import process from "node:process";

const HOUSE_RULES = "docs/house-rules.md";

/** Paths only the user may authorize an agent to change. */
const PROTECTED_PATTERNS = [
  /(^|\/)eslint\.config\.[cm]?[jt]s$/,
  /(^|\/)eslint-suppressions\.json$/,
  /(^|\/)tsconfig\.base\.json$/,
  /(^|\/)\.githooks\//,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)\.claude\/settings\.json$/,
  /(^|\/)\.cursor\/hooks\.json$/,
  /(^|\/)scripts\/agent-guards\//,
  /(^|\/)\.agents\/source-budgets\.json$/,
  /(^|\/)AGENTS\.md$/,
  /(^|\/)LICENSE\.md$/,
];

/** Tools that write. Anything else this hook sees is passed straight through. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "StrReplace", "NotebookEdit", "Delete"]);

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "target_file"];

/** True when `path` is one of the files the user owns. */
export function isProtected(path) {
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(path));
}

/** Every candidate path in a hook event, in either harness's shape. */
export function collectPaths(event) {
  const toolInput = event.tool_input ?? event.toolInput ?? event;
  const paths = [];
  for (const key of PATH_KEYS) {
    const fromTool = toolInput?.[key];
    if (typeof fromTool === "string") paths.push(fromTool);
    const fromEvent = event[key];
    if (typeof fromEvent === "string") paths.push(fromEvent);
  }
  return paths;
}

/**
 * The whole decision, as a function of the parsed event. `null` means stdin
 * was unreadable, which is the one case that must not silently allow.
 */
export function decide(event) {
  if (event === null || typeof event !== "object") {
    return {
      decision: "ask",
      reason: `The protected-file guard could not read its hook input, so it cannot tell what this edit touches (${HOUSE_RULES}).`,
    };
  }
  const toolName = event.tool_name ?? event.toolName ?? event.tool ?? "";
  if (typeof toolName === "string" && toolName !== "") {
    if (!EDIT_TOOLS.has(toolName)) return { decision: "allow", reason: "" };
  }
  const hit = collectPaths(event).find((path) => isProtected(path));
  if (hit === undefined) return { decision: "allow", reason: "" };
  return {
    decision: "ask",
    reason: `"${hit}" is a protected file (${HOUSE_RULES}) — an agent may not change the compiler, lint, ratchet, hook, guard, workflow, contract, or licence files without the user saying so out loud.`,
  };
}

/** Claude Code and Cursor want the same answer in two different envelopes. */
export function renderResponse(event, decision, reason) {
  const isClaude = event !== null && typeof event === "object" && typeof event.hook_event_name === "string";
  if (isClaude) {
    // An allow would bypass the user's own permission settings, so the quiet
    // answer is no answer: only `ask` and `deny` are opinions worth stating.
    if (decision === "allow") return "{}";
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    });
  }
  return JSON.stringify({
    permission: decision,
    userMessage: reason,
    agentMessage: reason,
    user_message: reason,
    agent_message: reason,
  });
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

const SELF_TEST_CASES = [
  ["Edit", "eslint.config.js", "ask", "lint config is protected"],
  ["Write", "tsconfig.base.json", "ask", "compiler config is protected"],
  ["Edit", ".githooks/pre-commit", "ask", "git hooks are protected"],
  ["Write", ".github/workflows/verify.yml", "ask", "the workflow is protected"],
  ["MultiEdit", ".claude/settings.json", "ask", "hook wiring is protected"],
  ["Edit", ".cursor/hooks.json", "ask", "cursor hook wiring is protected"],
  ["Write", "scripts/agent-guards/guard-shell-commands.mjs", "ask", "the guards guard themselves"],
  ["Edit", ".agents/source-budgets.json", "ask", "the ratchet baseline is protected"],
  ["Edit", "eslint-suppressions.json", "ask", "the suppression baseline is protected"],
  ["Edit", "AGENTS.md", "ask", "the contract document is protected"],
  ["Write", "LICENSE.md", "ask", "the licence is protected"],
  ["Edit", "/repo/local-repos/dads-framework/.githooks/pre-push", "ask", "absolute paths are matched too"],
  ["Edit", "packages/server/http/src/index.ts", "allow", "ordinary source is allowed"],
  ["Write", "docs/house-rules.md", "allow", "ordinary documents are allowed"],
  ["Write", "README.md", "allow", "README is not the licence"],
  ["Read", "AGENTS.md", "allow", "a read of a protected file is allowed"],
];

function selfTest() {
  const failures = [];
  for (const [tool, path, expected, label] of SELF_TEST_CASES) {
    const event = {
      hook_event_name: "PreToolUse",
      tool_name: tool,
      tool_input: { file_path: path },
    };
    const actual = decide(event).decision;
    if (actual !== expected) {
      failures.push(`${label}: ${tool} ${path} -> ${actual}, want ${expected}`);
    }
  }
  if (decide(null).decision !== "ask") {
    failures.push("malformed input must fail closed (ask)");
  }
  const total = SELF_TEST_CASES.length + 1;
  const lines = failures.map((failure) => `self-test FAIL ${failure}\n`);
  process.stdout.write(
    failures.length === 0
      ? `guard-protected-files self-test OK (${String(total)} cases)\n`
      : lines.join("") + `guard-protected-files self-test: ${String(failures.length)} of ${String(total)} failed\n`,
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

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const event = readEvent();
  const { decision, reason } = decide(event);
  process.stdout.write(renderResponse(event, decision, reason));
}
