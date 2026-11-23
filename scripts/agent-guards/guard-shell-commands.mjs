#!/usr/bin/env node
/**
 * Agent guard: shell commands that would remove a wall are refused.
 *
 * Runs as a pre-tool-use hook in Claude Code (`.claude/settings.json`, matcher
 * `Bash`) and Cursor (`.cursor/hooks.json`, `beforeShellExecution`). It reads
 * the hook event on stdin and looks at the command string only.
 *
 * Denied outright:
 *   - `--no-verify` on `git commit` or `git push` (the hooks are the point)
 *   - force-pushing `main` or `master`, in any spelling
 *   - deleting `main` or `master`, by branch or by push refspec
 *   - pushing `main` while the checkout is on some other branch
 * Escalated to the user:
 *   - `gh api` calls that touch rulesets or branch protection
 *   - anything at all when the hook input is unreadable
 *
 * Everything else is allowed, silently. `--self-test` proves the matrix.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOUSE_RULES = "docs/house-rules.md";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Matches `main`/`master` as a push or branch target, not as a prefix. */
const MAIN_TARGET = "(?:refs\\/heads\\/)?(?:main|master)(?![\\w./-])";

const DENY_RULES = [
  {
    name: "no-verify",
    pattern: /\bgit\s+(?:commit|push)\b[^;&|]*--no-verify/,
    reason: `--no-verify skips the hooks that stand in for CI (${HOUSE_RULES}). Fix what the hook reports instead.`,
  },
  {
    name: "force-push-main",
    pattern: new RegExp(
      `\\bgit\\s+push\\b[^;&|]*(?:--force\\b|--force-with-lease\\b|\\s-f\\b)[^;&|]*(?:\\s|:)${MAIN_TARGET}` +
        `|\\bgit\\s+push\\b[^;&|]*(?:\\s|:)${MAIN_TARGET}[^;&|]*(?:--force\\b|--force-with-lease\\b|\\s-f\\b)`,
    ),
    reason: `Force-pushing main rewrites shared history (${HOUSE_RULES}). --force-with-lease is for your own branches.`,
  },
  {
    name: "delete-main",
    pattern: new RegExp(
      `\\bgit\\s+branch\\b[^;&|]*\\s-[dD]\\b[^;&|]*\\s${MAIN_TARGET}` +
        `|\\bgit\\s+push\\b[^;&|]*(?:--delete\\s+|\\s:)(?:[^\\s;&|]+\\s+)?${MAIN_TARGET}`,
    ),
    reason: `Deleting main is never part of a task (${HOUSE_RULES}).`,
  },
];

/** A push whose refspec names main, whatever else is on the line. */
const PUSHES_MAIN = new RegExp(`\\bgit\\s+push\\b[^;&|]*(?:\\s|:)${MAIN_TARGET}`);

const ASK_RULES = [
  {
    name: "gh-api-protection",
    pattern: /\bgh\s+api\b[^;&|]*(?:rulesets|branch[_-]?protection|branches\/[^\s;&|]+\/protection)/i,
    reason: `This changes rulesets or branch protection — the enforcement the repository runs on (${HOUSE_RULES}). Confirm it with the user first.`,
  },
];

/**
 * The whole decision, as a function of the command and the branch the
 * checkout is on. `currentBranch` is `null` when git could not answer, which
 * is treated as "cannot tell" and escalated rather than allowed.
 */
export function decideForCommand(command, { currentBranch }) {
  if (typeof command !== "string") {
    return {
      decision: "ask",
      reason: `The shell guard could not read its hook input, so it cannot tell what this command does (${HOUSE_RULES}).`,
    };
  }
  for (const rule of DENY_RULES) {
    if (rule.pattern.test(command)) {
      return { decision: "deny", reason: rule.reason };
    }
  }
  if (PUSHES_MAIN.test(command)) {
    if (currentBranch === null) {
      return {
        decision: "ask",
        reason: `This pushes main and the guard could not read the current branch (${HOUSE_RULES}). Confirm before it runs.`,
      };
    }
    if (currentBranch !== "main" && currentBranch !== "master") {
      return {
        decision: "deny",
        reason: `This pushes main from "${currentBranch}" — work reaches main through a pull request, not a push (${HOUSE_RULES}).`,
      };
    }
  }
  for (const rule of ASK_RULES) {
    if (rule.pattern.test(command)) {
      return { decision: "ask", reason: rule.reason };
    }
  }
  return { decision: "allow", reason: "" };
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
  ["git commit --no-verify -m 'wip'", "chore/house-rules", "deny", "no-verify on commit"],
  ["git push --no-verify origin chore/house-rules", "chore/house-rules", "deny", "no-verify on push"],
  ["git push --force origin main", "main", "deny", "force-push main"],
  ["git push origin main --force-with-lease", "main", "deny", "force-with-lease after the refspec"],
  ["git push -f origin master", "master", "deny", "short force flag"],
  ["git branch -D main", "chore/house-rules", "deny", "delete main locally"],
  ["git push origin :main", "chore/house-rules", "deny", "delete by refspec"],
  ["git push --delete origin main", "chore/house-rules", "deny", "delete by flag"],
  ["git push origin HEAD:main", "chore/house-rules", "deny", "push main from a feature branch"],
  ["git push origin main", "main", "allow", "push main while on main"],
  ["git push origin main", null, "ask", "push main with an unknown branch asks"],
  ["gh api repos/o/r/rulesets --method POST", "chore/house-rules", "ask", "ruleset mutation asks"],
  ["gh api repos/o/r/branches/main/protection", "chore/house-rules", "ask", "branch protection asks"],
  [
    "git push --force-with-lease origin chore/house-rules",
    "chore/house-rules",
    "allow",
    "force-with-lease on a feature branch is fine",
  ],
  ["git push origin mainline", "chore/house-rules", "allow", "a branch that starts with main is not main"],
  ["npm run verify", "chore/house-rules", "allow", "ordinary commands"],
];

function selfTest() {
  const failures = [];
  for (const [command, currentBranch, expected, label] of SELF_TEST_CASES) {
    const actual = decideForCommand(command, { currentBranch }).decision;
    if (actual !== expected) {
      failures.push(`${label}: ${command} -> ${actual}, want ${expected}`);
    }
  }
  const malformed = decideForCommand(undefined, { currentBranch: "main" });
  if (malformed.decision !== "ask") {
    failures.push("malformed input must fail closed (ask)");
  }
  const total = SELF_TEST_CASES.length + 1;
  const lines = failures.map((failure) => `self-test FAIL ${failure}\n`);
  process.stdout.write(
    failures.length === 0
      ? `guard-shell-commands self-test OK (${String(total)} cases)\n`
      : lines.join("") + `guard-shell-commands self-test: ${String(failures.length)} of ${String(total)} failed\n`,
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

function readCurrentBranch() {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function commandOf(event) {
  if (event === null || typeof event !== "object") return null;
  const candidates = [event.command, event.tool_input?.command, event.toolInput?.command];
  return candidates.find((value) => typeof value === "string") ?? null;
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const event = readEvent();
  // A readable event with no command is not a shell call: nothing to judge.
  const command = event === null ? null : (commandOf(event) ?? "");
  const { decision, reason } = decideForCommand(command, {
    currentBranch: readCurrentBranch(),
  });
  process.stdout.write(renderResponse(event, decision, reason));
}
