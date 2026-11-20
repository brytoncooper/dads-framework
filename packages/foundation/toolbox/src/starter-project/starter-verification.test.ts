import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createDoctorContext } from "../doctor/doctor-context.js";
import { hookRuntimeSignal } from "../doctor/signals/dad-has-issues-too/hook-runtime.js";
import { ciWithoutVerifySignal } from "../doctor/signals/its-not-you-its-my-boundaries/ci-without-verify.js";
import { initializeDadsProject } from "../initialize-dads-project.js";
import { environmentWithoutGitVariables } from "../verification/git-environment.js";

function execute(root: string, command: string, args: readonly string[]) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...environmentWithoutGitVariables(),
      CI: "",
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
}

function succeeded(root: string, command: string, ...args: string[]): void {
  const result = execute(root, command, args);
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

function stage(root: string, content: string): void {
  writeFileSync(join(root, "source.txt"), content);
  succeeded(root, "git", "add", "source.txt");
}

it(
  "runs generated hooks against staged and pushed content and reports CI and timings",
  { timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "dad-starter-verification-"));
    const root = join(directory, "starter");
    const remote = join(directory, "remote.git");
    try {
      initializeDadsProject({
        targetDirectory: root,
        mode: "new",
        projectName: "starter-verification",
      });
      expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(
        "@AGENTS.md\n",
      );
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(
        readFileSync(
          new URL(
            "../../../../../apps/kit-workbench/AGENTS.md",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(existsSync(join(root, "DEPLOY.md"))).toBe(true);
      expect(existsSync(join(root, ".github/workflows/verify.yml"))).toBe(
        false,
      );
      expect(existsSync(join(root, ".gitlab-ci.yml"))).toBe(false);
      for (const path of [
        "ci/verify.sh",
        "ci/github-actions/verify.yml",
        "ci/gitlab/verify.yml",
      ]) {
        expect(readFileSync(join(root, path), "utf8")).toBe(
          readFileSync(
            new URL(`../../../../../${path}`, import.meta.url),
            "utf8",
          ),
        );
      }
      // Use an offline verification check that reads tracked content. The
      // generated npm wrapper, receipt implementation, and hooks run unchanged.
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "starter-verification",
          scripts: {
            "hooks:install": "sh .githooks/install",
            verify: "node scripts/verify.mjs",
            "verify:checks": "node check.mjs",
          },
        }),
      );
      writeFileSync(
        join(root, "check.mjs"),
        [
          'import { readFileSync } from "node:fs";',
          'import { execFileSync } from "node:child_process";',
          'if (execFileSync("git", ["log", "-1", "--format=%s"], { encoding: "utf8" }).trim() === "reject history") throw new Error("bad history");',
          'if (process.env.CI === "true") console.log("CI mode verified");',
          'if (readFileSync("source.txt", "utf8") !== "good\\n") throw new Error("bad source");',
        ].join("\n"),
      );
      succeeded(root, "git", "init", "-b", "main");
      succeeded(directory, "git", "init", "--bare", remote);
      succeeded(root, "git", "config", "user.name", "Dad Fixture");
      succeeded(root, "git", "config", "user.email", "fixture@dads.invalid");
      succeeded(root, "git", "config", "commit.gpgsign", "false");
      succeeded(root, "npm", "run", "hooks:install");
      succeeded(root, "npm", "install", "--package-lock-only");
      succeeded(root, "git", "remote", "add", "origin", remote);
      const require = createRequire(import.meta.url);
      mkdirSync(join(root, "node_modules"), { recursive: true });
      symlinkSync(
        dirname(require.resolve("typescript/package.json")),
        join(root, "node_modules", "typescript"),
        "junction",
      );

      mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
      symlinkSync(
        resolve(import.meta.dirname, "../../bin/dad.js"),
        join(root, "node_modules", ".bin", "dad"),
      );

      const beforeCi = createDoctorContext({ root });
      const before = await ciWithoutVerifySignal.run(beforeCi);
      expect(before.get("verify")?.value).toBe(1);
      expect(beforeCi.notes).toContain("no recognized CI workflow");
      writeFileSync(
        join(root, ".gitlab-ci.yml"),
        readFileSync(join(root, "ci/gitlab/verify.yml"), "utf8"),
      );
      succeeded(root, "git", "add", ".");
      stage(root, "bad whitespace \n");
      const refused = execute(root, "git", ["commit", "-m", "bad whitespace"]);
      expect(refused.status).not.toBe(0);
      expect(refused.stdout + refused.stderr).toContain("trailing whitespace");

      stage(root, "bad\n");
      const file = join(root, "proof-source.ts");
      writeFileSync(file, "export const input: any = 1;\n");
      succeeded(root, "git", "add", "proof-source.ts");
      writeFileSync(file, "export const input: number = 1;\n");
      const unsafe = execute(root, "git", [
        "commit",
        "-m",
        "unsafe staged code",
      ]);
      expect(unsafe.status).not.toBe(0);
      expect(unsafe.stdout + unsafe.stderr).toContain("disallowed AnyKeyword");
      succeeded(root, "git", "add", "proof-source.ts");
      const budgetPath = join(root, "apps", "customer", "oversized.ts");
      writeFileSync(budgetPath, "export {};\n".repeat(401));
      succeeded(root, "git", "add", "apps/customer/oversized.ts");
      const aboveBudget = execute(root, "git", [
        "commit",
        "-m",
        "oversized staged code",
      ]);
      expect(
        aboveBudget.status,
        aboveBudget.stdout + aboveBudget.stderr,
      ).not.toBe(0);
      expect(aboveBudget.stdout + aboveBudget.stderr).toContain(
        "fileLines apps/customer/oversized.ts",
      );
      rmSync(budgetPath);
      succeeded(root, "git", "add", "-u", "apps/customer/oversized.ts");
      succeeded(root, "git", "commit", "-m", "bad content");
      writeFileSync(join(root, "source.txt"), "good\n");
      const push = execute(root, "git", ["push", "origin", "main"]);
      expect(push.status).not.toBe(0);
      expect(push.stderr).toContain("bad source");
      expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("good\n");

      stage(root, "good\n");
      succeeded(root, "git", "commit", "-m", "fix content");
      succeeded(root, "npm", "run", "verify");
      succeeded(root, "git", "push", "origin", "main");
      const ciCheckout = join(directory, "ci-checkout");
      succeeded(
        directory,
        "git",
        "clone",
        "--branch",
        "main",
        remote,
        ciCheckout,
      );
      const gitlab = readFileSync(join(ciCheckout, ".gitlab-ci.yml"), "utf8");
      expect(gitlab).toMatch(/^ {4}- sh ci\/verify\.sh$/mu);
      const ciVerification = execute(ciCheckout, "sh", ["ci/verify.sh"]);
      expect(
        ciVerification.status,
        ciVerification.stdout + ciVerification.stderr,
      ).toBe(0);
      expect(ciVerification.stdout).toContain("CI mode verified");
      expect(
        existsSync(join(ciCheckout, ".git/dads/starter-verification")),
      ).toBe(false);

      succeeded(root, "git", "commit", "--allow-empty", "-m", "reject history");
      const sameTreePush = execute(root, "git", ["push", "origin", "main"]);
      expect(sameTreePush.status).not.toBe(0);
      expect(sameTreePush.stderr).toContain("bad history");

      const context = createDoctorContext({ root });
      const timing = await hookRuntimeSignal.run(context);
      expect([...timing.keys()]).toStrictEqual(["pre-commit", "pre-push"]);
      expect(context.notes?.join("\n")).toMatch(
        /pre-push median .*budget 60000 ms/,
      );
      const ci = await ciWithoutVerifySignal.run(context);
      expect(ci.get("verify")).toMatchObject({
        value: 0,
        evidence: [{ path: ".gitlab-ci.yml" }],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
